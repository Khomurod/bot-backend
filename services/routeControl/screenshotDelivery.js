/**
 * Sending a NEW route message to a driver group — the only Route Control path
 * that creates a Telegram message ("Send as new message"). In-place edits live
 * in telegramMessageEditor and never post anything new.
 *
 * Delivery shape, in order of preference:
 *   • no screenshot stored            → plain text message
 *   • screenshot + body ≤ caption max → single photo with the body as caption
 *   • screenshot + body too long      → photo (short caption) + a text message
 *   • photo send failed               → fall back to text, and report the failure
 *     truthfully instead of claiming the screenshot was delivered.
 */
const rc = require('../../database/routeControl');
const { safeSend } = require('../telegramHtml');
const { resolveDriverMentionForGroup, escapeHtml } = require('../driverMention');
const { serviceError, classifyTelegramPhotoError } = require('./errors');
const { buildDriverGroupRouteMessage } = require('./messageFormatter');
const { buildDeliveryMessageList } = require('./deliveryRecords');
const { TELEGRAM_CAPTION_MAX, PHOTO_ONLY_CAPTION } = require('./constants');
const { buildTelegramScreenshotUrl } = require('./screenshotMediaReference');

/**
 * Read the stored screenshot for a delivery. A DB read failure must never lose
 * the route text — it degrades to a text-only send with a reported error.
 */
async function readScreenshotForDelivery(assignmentId, logPrefix) {
  try {
    return { screenshot: await rc.getRouteScreenshot(assignmentId), screenshotError: null };
  } catch (readErr) {
    console.error(`[ROUTE-CONTROL] assignment=${assignmentId} ${logPrefix}=read_failed:`, readErr.message);
    return { screenshot: null, screenshotError: 'SCREENSHOT_DB_READ_FAILED' };
  }
}

/**
 * Send (or re-send) the assigned route message to the driver group's Telegram
 * chat. Tags the driver when a Telegram id/username is known, else uses the
 * plain name. Records the send on the assignment + an audit event. Throws a
 * CLEAR error when the group has no Telegram chat id or the send fails — the
 * caller decides how to surface it, and NEVER rolls back the assignment.
 *
 * @param {{ assignmentId:number, telegram:object, sentBy?:string,
 *           customMessage?:string }} p
 * @returns {Promise<{ sent:boolean, sentAt:string, messageId:(number|null),
 *                     chatId:number, mentionSource:string, mentionConfidence:string }>}
 */
async function sendDriverGroupRouteMessage({ assignmentId, telegram, sentBy = null, customMessage = null }) {
  const assignment = await rc.getRouteAssignment(assignmentId);
  if (!assignment) throw serviceError('NOT_FOUND', 'Route assignment not found.', 404);
  if (!assignment.group_id) {
    throw serviceError('NO_GROUP', 'This route is not tied to a driver group.', 400);
  }
  const chatId = assignment.telegram_group_id;
  if (chatId == null) {
    throw serviceError('NO_TELEGRAM_GROUP',
      'This driver group has no Telegram chat id, so the route message cannot be sent.', 400);
  }
  if (!telegram || typeof telegram.sendMessage !== 'function') {
    throw serviceError('NO_TELEGRAM', 'Telegram client is unavailable right now.', 503);
  }

  const mention = await resolveDriverMentionForGroup(assignment.group_id);
  const body = customMessage && String(customMessage).trim()
    ? escapeHtml(String(customMessage).trim())
    : buildDriverGroupRouteMessage(assignment, mention);

  // Attach the route screenshot when one is stored. A photo-send failure must
  // never lose the route text: fall back to the plain text message AND report
  // the failure truthfully (screenshotError in the result + persisted on the
  // assignment) — never claim the screenshot was delivered when it wasn't.
  const read = await readScreenshotForDelivery(assignmentId, 'screenshot');
  const screenshot = read.screenshot;
  let screenshotError = read.screenshotError;

  let photoMessageId = null;
  let textMessageId = null;
  let sentVia = 'text';
  if (screenshot?.file_data) {
    try {
      // A URL keeps this Bot API call JSON-only. Telegram downloads the image
      // from our short-lived signed endpoint, avoiding Render's stalled
      // multipart upload path while preserving the stored DB screenshot.
      const screenshotUrl = buildTelegramScreenshotUrl({ assignmentId, screenshot });
      if (body.length <= TELEGRAM_CAPTION_MAX) {
        const sent = await safeSend(() => telegram.sendPhoto(chatId, screenshotUrl, {
          caption: body,
          parse_mode: 'HTML',
        }));
        photoMessageId = sent?.message_id ?? null;
        sentVia = 'photo';
      } else {
        const sentPhoto = await safeSend(() => telegram.sendPhoto(chatId, screenshotUrl, {
          caption: PHOTO_ONLY_CAPTION,
          parse_mode: 'HTML',
        }));
        const sentText = await safeSend(() => telegram.sendMessage(chatId, body, {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }));
        photoMessageId = sentPhoto?.message_id ?? null;
        textMessageId = sentText?.message_id ?? null;
        sentVia = 'photo+text';
      }
    } catch (photoErr) {
      screenshotError = classifyTelegramPhotoError(photoErr);
      console.error(
        `[ROUTE-CONTROL] assignment=${assignmentId} screenshot=send_failed reason=${screenshotError}`
        + ' (falling back to text)'
      );
      sentVia = 'text';
    }
  }
  if (sentVia === 'text') {
    try {
      const sent = await safeSend(() => telegram.sendMessage(chatId, body, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }));
      textMessageId = sent?.message_id ?? null;
    } catch (textErr) {
      // Photo (if any) AND text failed → complete failure. Nothing is marked
      // sent and after-message tracking is NOT activated; the screenshot stays
      // stored so a later retry can use it.
      if (!textErr.code) textErr.code = 'TELEGRAM_TEXT_SEND_FAILED';
      throw textErr;
    }
  }

  // The full ordered set of Telegram messages this delivery is made of, so each
  // part can later be edited in place. Legacy scalar id kept for the admin list.
  const messages = buildDeliveryMessageList({ via: sentVia, photoMessageId, textMessageId });
  const messageId = textMessageId ?? photoMessageId ?? null;
  await rc.recordDriverGroupMessageSent(assignmentId, {
    telegramMessageId: messageId, sentBy, via: sentVia, screenshotError, messages,
  });
  await rc.insertRouteMonitorEvent({
    assignmentId,
    eventType: 'driver_group_message_sent',
    detail: `route message sent to driver group${sentBy ? ` by ${sentBy}` : ''}`
      + `${messageId ? ` (telegram msg ${messageId})` : ''}`
      + ` [via:${sentVia}]${screenshotError ? ` [screenshot_error:${screenshotError}]` : ''}`
      + ` [mention:${mention.source}/${mention.confidence}]`,
  });
  console.log(
    `[ROUTE-CONTROL] assignment=${assignmentId} screenshot=${screenshot?.file_data ? 'stored' : 'none'}`
    + ` send_via=${sentVia}${messageId ? ` telegram_message_id=${messageId}` : ''}`
    + `${screenshotError ? ` screenshot_error=${screenshotError}` : ''}`
  );

  // After-message start mode: a successful send is the start condition.
  let trackingActivated = false;
  if (assignment.tracking_start_mode === 'after_message_sent' && assignment.tracking_status === 'pending') {
    const activated = await rc.activateTracking(assignmentId);
    if (activated) {
      trackingActivated = true;
      await rc.insertRouteMonitorEvent({
        assignmentId,
        eventType: 'tracking_started',
        detail: 'route message sent — tracking is now active',
      });
    }
  }

  return {
    sent: true,
    sentAt: new Date().toISOString(),
    messageId,
    chatId,
    sentVia,
    withScreenshot: sentVia !== 'text',
    screenshotStored: Boolean(screenshot?.file_data),
    screenshotError,
    trackingActivated,
    mentionSource: mention.source,
    mentionConfidence: mention.confidence,
  };
}

module.exports = {
  readScreenshotForDelivery,
  sendDriverGroupRouteMessage,
};
