/**
 * IN-PLACE editing of the already-sent driver-group route message(s).
 *
 * This module NEVER posts a new Telegram message — "Send as new message"
 * (screenshotDelivery) is the only action allowed to create one. It honours the
 * real Bot API limits: a photo message's image can be REPLACED
 * (editMessageMedia) but not removed, and a text message can be converted INTO a
 * photo in place (Bot API 7.11+) keeping the same message id. When a requested
 * change is impossible it does what it can, changes nothing it shouldn't, sends
 * nothing new, and reports the limitation truthfully.
 *
 * OWNER of the in-flight edit guard (`editingAssignments`): this is the single
 * piece of mutable module state in the Route Control package, and it lives here
 * because this is the only module that performs edits. Restart-safety comes from
 * the DB message list, not this set.
 */
const rc = require('../../database/routeControl');
const { resolveDriverMentionForGroup, escapeHtml } = require('../driverMention');
const { runTelegramEditWithRetry } = require('../telegramEdit');
const { serviceError } = require('./errors');
const { buildDriverGroupRouteMessage, estimatedCaptionLength } = require('./messageFormatter');
const { parseDeliveryMessages } = require('./deliveryRecords');
const { readScreenshotForDelivery } = require('./screenshotDelivery');
const { makeEditCorrelationId, logEditAttempt, logEditFinal } = require('./diagnostics');
const {
  deriveScreenshotSendError, deriveEditCode, deriveEditStatus, describeEditOutcome,
} = require('./editOutcome');
const { TELEGRAM_CAPTION_MAX, PHOTO_ONLY_CAPTION } = require('./constants');

// Per-assignment in-flight guard for in-place Telegram edits, so two admin
// requests that land close together (double-click, replace + remove) can't fire
// duplicate edits of the same message.
const editingAssignments = new Set();

/** The immutable defaults every early-return and the final result build on. */
function baseResult({ chatId, screenshotStored, correlationId }) {
  return {
    updated: false,
    telegramChanged: false,
    textUpdated: false,
    screenshotUpdated: false,
    screenshotRemovedInTelegram: false,
    screenshotStored,
    chatId: chatId ?? null,
    limitations: [],
    editError: null,
    // ── Structured, safe Telegram status (for the Admin API + logs) ──
    ok: false,
    status: 'failed',
    operation: 'none',
    category: 'unknown',
    retryable: false,
    ambiguousOutcome: false,
    attempts: 0,
    telegramErrorCode: null,
    transportCode: null,
    retryAfterSeconds: null,
    correlationId,
  };
}

/**
 * Update the ALREADY-SENT driver-group route message(s) IN PLACE — never posts a
 * new message.
 *
 * @param {{ assignmentId:number, telegram:object, mediaTelegram?:object,
 *           customMessage?:string, retry?:object }} p
 * @returns {Promise<object>} structured status (never throws for a Telegram-side
 *   failure — that is reported in the result so the admin sees the truth).
 */
async function updateDriverGroupRouteMessage({
  assignmentId, telegram, mediaTelegram = null, customMessage = null, retry = {},
}) {
  const assignment = await rc.getRouteAssignment(assignmentId);
  if (!assignment) throw serviceError('NOT_FOUND', 'Route assignment not found.', 404);

  const chatId = assignment.telegram_group_id;
  const correlationId = makeEditCorrelationId(assignmentId);
  // Media edits (multipart photo uploads) go through a dedicated fresh-socket
  // client so a retry never reuses a half-dead keep-alive socket; small text /
  // caption edits use the normal client. Both default to the injected client so
  // tests inject one fake.
  const mediaClient = mediaTelegram || telegram;
  const base = baseResult({
    chatId, screenshotStored: Boolean(assignment.has_screenshot), correlationId,
  });

  const { messages, legacy } = parseDeliveryMessages(assignment);

  // Never sent (or no editable message id on file) → storage-only. Do NOT send
  // anything: creating a message must be a separate, explicit admin action.
  if (!messages.length) {
    const detail = assignment.driver_group_message_sent_at
      ? 'The route was sent earlier but no editable Telegram message id is on file, so it cannot be updated in place. Use “Send as new message” to post a fresh one.'
      : 'No route message has been sent to the driver group yet — only the stored route was updated.';
    return { ...base, code: 'NO_SENT_MESSAGE', status: 'not_sent', category: 'validation', detail, description: detail };
  }
  if (chatId == null) {
    const detail = 'This driver group has no Telegram chat id, so the message cannot be updated.';
    return { ...base, code: 'NO_TELEGRAM_GROUP', status: 'failed', category: 'validation', editError: 'NO_TELEGRAM_GROUP', detail, description: detail };
  }
  if (!telegram || typeof telegram.editMessageText !== 'function') {
    throw serviceError('NO_TELEGRAM', 'Telegram client is unavailable right now.', 503);
  }

  // Collapse near-simultaneous requests for the same route (double-click, or a
  // replace immediately followed by a remove) so we never double-edit.
  if (editingAssignments.has(assignmentId)) {
    const detail = 'Another update for this route is already in progress — try again in a moment.';
    return { ...base, code: 'EDIT_IN_PROGRESS', status: 'in_progress', retryable: true, detail, description: detail };
  }
  editingAssignments.add(assignmentId);
  try {
    const read = await readScreenshotForDelivery(assignmentId, 'edit screenshot');
    if (read.screenshotError) base.limitations.push('SCREENSHOT_DB_READ_FAILED');
    const screenshot = read.screenshot;
    const hasScreenshot = Boolean(screenshot?.file_data);

    const mention = await resolveDriverMentionForGroup(assignment.group_id);
    const body = customMessage && String(customMessage).trim()
      ? escapeHtml(String(customMessage).trim())
      : buildDriverGroupRouteMessage(assignment, mention);

    const photoMsg = messages.find((m) => m.kind === 'photo') || null;
    const textMsg = messages.find((m) => m.kind === 'text') || null;
    const limitations = base.limitations;
    let textUpdated = false;
    let screenshotUpdated = false;
    let convertedToPhoto = false;
    let captionTooLongForConversion = false;
    let editError = null;
    let attemptsTotal = 0;
    let abortedAttemptsTotal = 0;
    let modifiedOps = 0;
    let alreadyUpToDateOps = 0;
    let firstFailClass = null;
    let primaryOperation = 'none';

    // Each edit runs through the bounded ABORTABLE retry wrapper: fn receives
    // { signal, attempt, correlationId }; transient transport/5xx/429 failures
    // are retried on the SAME message id (never a new message) only after the
    // previous attempt fully settles; permanent failures return immediately; a
    // "message is not modified" is success (first attempt ⇒ already up to date,
    // later attempt ⇒ a lost-response edit is hereby CONFIRMED). sleep/random/
    // timeout are injectable for deterministic tests.
    const runEdit = async (fn, operation) => {
      if (primaryOperation === 'none') primaryOperation = operation;
      const r = await runTelegramEditWithRetry(fn, {
        operation,
        correlationId,
        sleep: retry.sleep,
        random: retry.random,
        maxAttempts: retry.maxAttempts,
        baseDelayMs: retry.baseDelayMs,
        perAttemptTimeoutMs: retry.perAttemptTimeoutMs,
        onAttempt: (a) => logEditAttempt({ correlationId, assignmentId, operation, chatId, ...a }),
      });
      attemptsTotal = Math.max(attemptsTotal, r.attempts);
      abortedAttemptsTotal += r.abortedAttempts || 0;
      if (r.ok) {
        if (r.notModified && r.attempts === 1) alreadyUpToDateOps += 1;
        else modifiedOps += 1;
        return { ok: true, attempts: r.attempts, notModified: r.notModified };
      }
      if (!firstFailClass) firstFailClass = r.classification;
      return { ok: false, code: r.classification.code, attempts: r.attempts, classification: r.classification };
    };

    // The caption that belongs on the PHOTO part: the short shared caption when
    // the body rides in its own text message, else the body itself.
    let photoCaption = PHOTO_ONLY_CAPTION;
    if (photoMsg && !textMsg) {
      if (body.length <= TELEGRAM_CAPTION_MAX) photoCaption = body;
      else limitations.push('CAPTION_TOO_LONG');
    }

    // 1) Photo part.
    if (photoMsg) {
      if (hasScreenshot) {
        // Raw callApi (not the wrapper) so the per-attempt AbortSignal reaches
        // the HTTP layer and a stalled multipart upload is genuinely cancelled.
        // Payload mirrors Telegraf 4.16's own editMessageMedia wrapper, minus
        // inline_message_id (never set for a normal chat message).
        const r = await runEdit(({ signal }) => mediaClient.callApi('editMessageMedia', {
          chat_id: String(chatId),
          message_id: Number(photoMsg.message_id),
          media: { type: 'photo', media: { source: screenshot.file_data }, caption: photoCaption, parse_mode: 'HTML' },
        }, { signal }), 'edit_media');
        if (r.ok) { screenshotUpdated = true; if (!textMsg) textUpdated = true; }
        else { editError = editError || r.code; limitations.push(`SCREENSHOT_UPDATE_FAILED:${r.code}`); }
      } else {
        // Screenshot removed from storage — but Telegram can't strip the image
        // out of a photo message in place. Keep the caption/text current and
        // report the limitation truthfully instead of pretending it's gone.
        limitations.push('PHOTO_IMAGE_CANNOT_BE_REMOVED_IN_PLACE');
        if (!textMsg) {
          const r = await runEdit(() => telegram.editMessageCaption(
            String(chatId), Number(photoMsg.message_id), undefined, photoCaption, { parse_mode: 'HTML' }
          ), 'edit_caption');
          if (r.ok) textUpdated = true;
          else editError = editError || r.code;
        }
      }
    }

    // 2) Text part.
    if (textMsg) {
      if (!photoMsg && hasScreenshot) {
        // Adding a screenshot to a TEXT-ONLY delivery: convert the existing text
        // message into a photo IN PLACE (Bot API 7.11+ lets editMessageMedia
        // replace a text message with media). Same message id, nothing new sent.
        // The full route body becomes the photo caption, so it must fit the
        // 1024-char caption limit — otherwise we'd have to drop route text or
        // post a second message, so we decline and report it instead.
        if (estimatedCaptionLength(body) > TELEGRAM_CAPTION_MAX) {
          captionTooLongForConversion = true;
          limitations.push('CAPTION_TOO_LONG_FOR_IN_PLACE_CONVERSION');
          // Leave the Telegram message unchanged — no truncation, no new message.
        } else {
          // Raw callApi with the per-attempt AbortSignal (see the photo branch
          // above); same message id — the text message BECOMES the photo.
          const r = await runEdit(({ signal }) => mediaClient.callApi('editMessageMedia', {
            chat_id: String(chatId),
            message_id: Number(textMsg.message_id),
            media: { type: 'photo', media: { source: screenshot.file_data }, caption: body, parse_mode: 'HTML' },
          }, { signal }), 'edit_media_text_to_photo');
          if (r.ok) {
            // The body is now the photo caption → both the image and the text changed.
            screenshotUpdated = true;
            textUpdated = true;
            convertedToPhoto = true;
          } else {
            editError = editError || r.code;
            limitations.push(`SCREENSHOT_CONVERT_FAILED:${r.code}`);
          }
        }
      } else {
        // Plain text edit: a text-only route without a screenshot, or the text
        // half of a photo+text delivery.
        const r = await runEdit(() => telegram.editMessageText(
          String(chatId), Number(textMsg.message_id), undefined, body,
          { parse_mode: 'HTML', disable_web_page_preview: true }
        ), 'edit_text');
        if (r.ok) textUpdated = true;
        else { editError = editError || r.code; limitations.push(`TEXT_UPDATE_FAILED:${r.code}`); }
      }
    }

    // Removal is only truly reflected in Telegram when there was no photo to
    // begin with (text-only delivery).
    const screenshotRemovedInTelegram = !hasScreenshot && !photoMsg;

    const telegramChanged = textUpdated || screenshotUpdated;
    // Every Telegram op returned first-attempt "message is not modified" → the
    // message was ALREADY in the desired state. Report that truthfully instead
    // of claiming a change was made. (Not-modified on a LATER attempt counts as
    // a real, confirmed change — an earlier lost-response request had applied.)
    const alreadyUpToDate = telegramChanged && !editError
      && modifiedOps === 0 && alreadyUpToDateOps > 0 && !limitations.length;

    const screenshotSendError = deriveScreenshotSendError({
      hasScreenshot, screenshotUpdated, hasPhotoMessage: Boolean(photoMsg), editError,
      captionTooLongForConversion,
    });
    const code = deriveEditCode({
      captionTooLongForConversion, telegramChanged, editError, limitations, alreadyUpToDate,
    });

    // Persist. A text→photo conversion keeps the SAME message id but changes the
    // message TYPE, so we rewrite `via` + the message list ONLY on confirmed
    // Telegram success (convertedToPhoto is set only when the edit succeeded).
    // An ambiguous/failed outcome therefore leaves delivery metadata unchanged.
    await rc.recordDriverGroupMessageEdit(assignmentId, {
      editError: editError || (limitations.length ? limitations.join(',') : null),
      screenshotError: screenshotSendError,
      via: convertedToPhoto ? 'photo' : undefined,
      messages: convertedToPhoto
        ? [{ message_id: Number(textMsg.message_id), kind: 'photo' }]
        : undefined,
    });

    const conversion = convertedToPhoto
      ? 'text_to_photo'
      : (photoMsg && screenshotUpdated ? 'photo_replace' : 'none');
    const detail = describeEditOutcome({
      code, textUpdated, screenshotUpdated, hasScreenshot, limitations, editError,
      converted: convertedToPhoto, classification: firstFailClass, attempts: attemptsTotal,
      alreadyUpToDate,
    });

    // ── Structured, safe Telegram status (Admin API + logs) ──
    const cls = firstFailClass;
    const status = deriveEditStatus({
      alreadyUpToDate, telegramChanged, editError, limitations, captionTooLongForConversion,
      classification: cls, code,
    });
    const ok = status === 'updated' || status === 'no_change';
    const ambiguousOutcome = status === 'unconfirmed';
    const category = cls?.category || (captionTooLongForConversion ? 'validation' : (ok ? 'none' : 'unknown'));

    await rc.insertRouteMonitorEvent({
      assignmentId,
      eventType: 'driver_group_message_edited',
      detail: `in-place edit: status=${status} text=${textUpdated} screenshot=${screenshotUpdated} removed=${!hasScreenshot}`
        + `${convertedToPhoto ? ' converted=text_to_photo' : ''} attempts=${attemptsTotal}`
        + `${legacy ? ' [legacy-record]' : ''}${limitations.length ? ` [limits:${limitations.join('|')}]` : ''}`
        + `${editError ? ` [error:${editError}]` : ''} [cid:${correlationId}]`,
    });
    logEditFinal({
      cid: correlationId,
      assignment: assignmentId,
      operation: primaryOperation,
      status,
      code,
      category,
      attempts: attemptsTotal,
      abortedAttempts: abortedAttemptsTotal,
      ambiguousOutcome,
      transportCode: cls?.transportCode || null,
      telegramErrorCode: cls?.telegramErrorCode ?? null,
      retryable: cls?.retryable ?? false,
      hasChatId: chatId != null,
      hasMessageId: messages.length > 0,
      hasScreenshot,
      metadataUpdated: convertedToPhoto,
      newMessageSent: false,
    });

    return {
      ...base,
      updated: telegramChanged,
      telegramChanged,
      textUpdated,
      screenshotUpdated,
      screenshotRemovedInTelegram,
      converted: convertedToPhoto,
      conversion,
      screenshotStored: hasScreenshot,
      via: convertedToPhoto ? 'photo' : (assignment.driver_group_message_via || null),
      limitations,
      editError,
      code,
      // Structured status fields (override base defaults).
      ok,
      status,
      operation: primaryOperation,
      category,
      retryable: cls?.retryable ?? false,
      ambiguousOutcome,
      attempts: attemptsTotal,
      abortedAttempts: abortedAttemptsTotal,
      alreadyUpToDate,
      telegramErrorCode: cls?.telegramErrorCode ?? null,
      transportCode: cls?.transportCode || null,
      retryAfterSeconds: cls?.retryAfterSeconds ?? null,
      description: cls?.description || detail,
      detail,
    };
  } finally {
    editingAssignments.delete(assignmentId);
  }
}

module.exports = { updateDriverGroupRouteMessage };
