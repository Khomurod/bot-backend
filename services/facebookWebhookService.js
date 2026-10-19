/**
 * The durable Facebook webhook QUEUE: intake, dedupe, claim, retry, recovery.
 *
 * This module owns when an event runs, not what it means. A lead's own
 * processing (Telegram post → Bitrix record → `leads` row → auto-SMS from the
 * assigned recruiter's number) lives in services/facebookLeadEventProcessor.js;
 * `buildAutoMessageNotification` is re-exported from here because that is where
 * its callers have always imported it from.
 *
 * It also owns the Telegram client for both, configured once at boot and passed
 * down explicitly — one owner for shared mutable state (CLAUDE.md).
 */
const db = require('../database/db');
const config = require('../config/config');
const { decryptText } = require('../lib/security/facebookCrypto');
const { stripUrls } = require('../lib/security/redactUrls');
const { safeSend } = require('./telegramHtml');
const { fetchSenderProfile } = require('./facebookGraphService');
const { formatMessengerMessage } = require('./facebookLeadFormatter');
const { noteHeartbeat } = require('./operations/runLedger');
const {
  processLeadEvent,
  buildAutoMessageNotification,
} = require('./facebookLeadEventProcessor');
const {
  createQueueWakeScheduler,
  resolveSweepMs,
} = require('./jobQueueScheduler');

let telegramClient = null;
let scheduler = null;
let drainInProgress = false;
let drainQueued = false;
// Set once stopFacebookWebhookWorker() has run. A drain queued on setImmediate
// (by startup, or by a webhook that landed mid-shutdown) must not open new
// queries while the pool is draining. Nothing is lost: the event is already
// persisted as 'pending' and the next boot's recovery drain claims it.
let workerStopped = false;

function configureFacebookLeadTelegram(telegram) {
  telegramClient = telegram;
}

function ensureTelegramConfigured() {
  if (!telegramClient) {
    throw new Error('Facebook webhook worker has no Telegram client configured');
  }
}

function extractFacebookWebhookEvents(payload) {
  const out = [];
  if (!payload || payload.object !== 'page') return out;

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      if (change?.field !== 'leadgen') continue;
      const value = change?.value || {};
      if (!value.leadgen_id) continue;
      const pageId = String(value.page_id || entry.id || '');
      if (!pageId) continue;
      out.push({
        eventKey: `leadgen:${pageId}:${value.leadgen_id}`,
        pageId,
        eventType: 'leadgen',
        payload: {
          pageId,
          leadgenId: String(value.leadgen_id),
          value,
          entryId: entry.id || null,
        },
      });
    }

    for (const event of entry.messaging || []) {
      const pageId = String(entry.id || event?.recipient?.id || '');
      if (!pageId) continue;
      const senderId = String(event?.sender?.id || 'unknown');
      const mid = event?.message?.mid || event?.delivery?.mids?.[0] || event?.read?.watermark || '';
      const timestamp = event?.timestamp || Date.now();
      out.push({
        eventKey: `messaging:${pageId}:${mid || `${senderId}:${timestamp}`}`,
        pageId,
        eventType: 'messaging',
        payload: {
          pageId,
          event,
        },
      });
    }
  }

  return out;
}

/**
 * How many times an event is tried before it is abandoned.
 *
 * An event that fails five times in a row — spread over about an hour and a
 * half, so a short Telegram or Meta outage is ridden out — will not succeed on
 * its own: a missing Page connection, a deleted lead, an expired token. Before
 * this cap a test lead from May was retried every fifteen minutes for five
 * months (9,041 attempts). Abandoning it tells the leads group once; Retry in
 * the admin puts it back with a fresh budget.
 */
const MAX_EVENT_ATTEMPTS = 5;

/** Wait after the Nth failed attempt: 1, 5, 15, then 60 minutes. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];

function getRetryDelayMs(attemptCount) {
  const index = Math.max(1, Number(attemptCount) || 1) - 1;
  return RETRY_DELAYS_MS[Math.min(index, RETRY_DELAYS_MS.length - 1)];
}

async function sendTelegramMessage(chatId, text) {
  ensureTelegramConfigured();
  return safeSend(() => telegramClient.sendMessage(chatId, text));
}

function buildMessengerText(event) {
  const message = event?.message || {};
  let messageText = message?.text || '';
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  if (attachments.length) {
    const types = attachments.map((attachment) => attachment?.type || 'unknown').join(', ');
    messageText = messageText
      ? `${messageText}\n[Attachments: ${types}]`
      : `[Attachments: ${types}]`;
  }
  return messageText || '(no text)';
}

async function processMessagingEvent(eventRow) {
  const pageId = String(eventRow.page_id);
  const event = eventRow.payload?.event || {};
  const message = event?.message || {};

  if (message?.is_echo) return;
  if (event?.delivery || event?.read) return;

  const senderId = String(event?.sender?.id || '');
  if (!senderId) return;

  const alreadySeen = await db.hasFacebookSenderBeenSeen(pageId, senderId);
  if (alreadySeen) return;

  const connection = await db.getFacebookPageConnectionByPageId(pageId);
  if (!connection) {
    throw new Error(`No active Facebook Page connection found for page ${pageId}`);
  }

  const pageAccessToken = decryptText(connection.access_token_encrypted);
  const senderProfile = await fetchSenderProfile({ senderId, pageAccessToken });
  const telegramMessage = formatMessengerMessage(
    senderProfile,
    buildMessengerText(event),
    senderId
  );

  await sendTelegramMessage(connection.telegram_group_id, telegramMessage);
  await db.recordFacebookSenderSeen(pageId, senderId, eventRow.event_key);
}

/** The one message the leads group gets when an event is abandoned. */
function buildAbandonedNotice(eventRow, errorMessage) {
  const kind = eventRow.event_type === 'leadgen' ? 'A Facebook lead' : 'A Facebook message';
  const id = eventRow.payload?.leadgenId || eventRow.event_key;
  // A group chat is no place for a URL out of an error: a Graph request URL
  // carries the Page's access token.
  const reason = stripUrls(String(errorMessage || 'Unknown error')).slice(0, 300);
  return `⚠️ ${kind} could not be processed after ${MAX_EVENT_ATTEMPTS} attempts and was stopped.\n`
    + `ID: ${id}\n`
    + `Last error: ${reason}\n`
    + 'Press Retry on the admin Facebook Leads page once the cause is fixed.';
}

/**
 * Stop retrying an event and say so once. Never throws: the drain must go on
 * to the next event whatever happens here.
 */
async function abandonEvent(eventRow, errorMessage) {
  try {
    await db.abandonFacebookWebhookEvent(eventRow.id, errorMessage);
  } catch (err) {
    console.error(`[WebhookWorker] Could not abandon event ${eventRow.id}:`, err.message);
    return;
  }
  console.warn(`[WebhookWorker] Event ${eventRow.event_key} abandoned after `
    + `${eventRow.attempt_count} attempts: ${errorMessage}`);
  let chatId = config.leadsTelegramChatId;
  try {
    const connection = await db.getFacebookPageConnectionByPageId(String(eventRow.page_id));
    if (connection?.telegram_group_id) chatId = connection.telegram_group_id;
  } catch (_) { /* the default leads group still hears about it */ }
  try {
    await sendTelegramMessage(chatId, buildAbandonedNotice(eventRow, errorMessage));
  } catch (err) {
    console.error(`[WebhookWorker] Could not report abandoned event ${eventRow.id}:`, err.message);
  }
}

async function processFacebookWebhookEvent(eventRow) {
  if (eventRow.event_type === 'leadgen') {
    ensureTelegramConfigured();
    await processLeadEvent(eventRow, { telegram: telegramClient });
    return;
  }
  if (eventRow.event_type === 'messaging') {
    await processMessagingEvent(eventRow);
    return;
  }
  throw new Error(`Unsupported Facebook webhook event type: ${eventRow.event_type}`);
}

function triggerDrain() {
  if (workerStopped) return;
  drainFacebookWebhookQueue().catch(err => console.error('[WebhookWorker] Drain error:', err.message));
}

async function drainFacebookWebhookQueue() {
  if (drainInProgress) {
    drainQueued = true;
    return;
  }

  drainInProgress = true;
  // Only a drain that ran the claim loop to exhaustion proves nothing is due.
  // If it threw (no Telegram client, database down) the queue may still hold
  // due rows, and arming a precise wake for a past timestamp would spin — the
  // idle sweep retries that case instead.
  let drainedCleanly = false;
  try {
    ensureTelegramConfigured();
    while (true) {
      const events = await db.claimPendingFacebookWebhookEvents(10);
      if (!events.length) break;

      for (const eventRow of events) {
        try {
          await processFacebookWebhookEvent(eventRow);
          await db.completeFacebookWebhookEvent(eventRow.id);
        } catch (err) {
          if (Number(eventRow.attempt_count) >= MAX_EVENT_ATTEMPTS) {
            await abandonEvent(eventRow, err.message);
          } else {
            const retryAt = new Date(Date.now() + getRetryDelayMs(eventRow.attempt_count));
            await db.failFacebookWebhookEvent(eventRow.id, err.message, retryAt);
          }
        }
      }
    }
    drainedCleanly = true;
  } finally {
    drainInProgress = false;
    // A drain that completed its claim loop is the only proof this worker is
    // alive: an idle queue writes no rows, so "nothing came in" and "the drain
    // has been broken since Tuesday" are the same empty table without this.
    //
    // DELIBERATELY NOT AWAITED. `drainInProgress` has just been cleared, so an
    // await here would open a window in which a queued drain starts while this
    // one is still inside its own `finally` — an observation changing the
    // behaviour it observes. It also cost this file's "an idle worker does not
    // poll" test three next-due lookups instead of one.
    noteHeartbeat('facebook_webhooks', {
      status: drainedCleanly ? 'ok' : 'error',
      detail: drainedCleanly ? null : 'the drain did not run its claim loop to exhaustion',
    }).catch(() => {});
    if (drainQueued) {
      drainQueued = false;
      setImmediate(triggerDrain);
    } else if (drainedCleanly && scheduler) {
      // Nothing is due right now: sleep until the earliest scheduled retry
      // rather than re-asking PostgreSQL on a fixed tick.
      void scheduler.afterDrain();
    }
  }
}

/**
 * Earliest `next_retry_at` among events still awaiting work, or null when the
 * queue is quiet. One query per drain replaces the old fixed-interval polling.
 */
async function getNextFacebookRetryDueAt() {
  const res = await db.query(`
    SELECT MIN(next_retry_at) AS next_due_at
      FROM facebook_webhook_events
     WHERE status IN ('pending', 'failed')
  `);
  return res.rows[0]?.next_due_at ?? null;
}

async function enqueueVerifiedFacebookPayload(payload) {
  const events = extractFacebookWebhookEvents(payload);
  if (!events.length) {
    return { received: 0, inserted: 0 };
  }

  const inserted = await db.insertFacebookWebhookEvents(events);
  if (inserted.length) {
    // Immediate, on this tick — a lead never waits for a timer.
    setImmediate(triggerDrain);
  }

  return { received: events.length, inserted: inserted.length };
}

async function retryFacebookWebhookEvent(identifier) {
  const event = await db.resetFacebookWebhookEventByIdentifier(identifier);
  if (event) {
    setImmediate(triggerDrain);
  }
  return event;
}

async function getFacebookWebhookLog(limit = 50) {
  return db.getRecentFacebookWebhookEvents(limit);
}

async function startFacebookWebhookWorker() {
  if (scheduler) return;
  workerStopped = false;

  // Crash recovery: a row left 'processing' by a killed instance is re-queued
  // with its attempt budget preserved, so a restart never strands a lead.
  try {
    await db.query(`
      UPDATE facebook_webhook_events
      SET status = 'pending', attempt_count = LEAST(attempt_count, 4)
      WHERE status = 'processing'
    `);
    // An event that already spent its budget — including any left over from
    // before the cap existed — is abandoned, not retried. Quietly: these are
    // old, and announcing each one at every boot would be noise.
    await db.query(`
      UPDATE facebook_webhook_events
      SET status = 'abandoned', updated_at = NOW()
      WHERE status IN ('pending', 'failed') AND attempt_count >= $1
    `, [MAX_EVENT_ATTEMPTS]);
  } catch (err) {
    console.error('[WebhookWorker] Recovery error:', err.message);
  }

  const sweepMs = resolveSweepMs(process.env.FACEBOOK_WEBHOOK_SWEEP_MS);
  scheduler = createQueueWakeScheduler({
    onWake: triggerDrain,
    getNextDueAt: getNextFacebookRetryDueAt,
    sweepMs,
  });
  scheduler.start();
  console.log(
    `[WebhookWorker] Event-driven; retries wake on their own next_retry_at, `
    + `idle sweep every ${Math.round(sweepMs / 1000)}s.`
  );

  // Recover pending work immediately at startup — not on the first sweep.
  setImmediate(triggerDrain);
}

async function stopFacebookWebhookWorker() {
  workerStopped = true;
  if (scheduler) {
    scheduler.stop();
    scheduler = null;
  }
  while (drainInProgress) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

module.exports = {
  configureFacebookLeadTelegram,
  startFacebookWebhookWorker,
  stopFacebookWebhookWorker,
  enqueueVerifiedFacebookPayload,
  retryFacebookWebhookEvent,
  getFacebookWebhookLog,
  extractFacebookWebhookEvents,
  buildAutoMessageNotification,
  buildAbandonedNotice,
  getRetryDelayMs,
  MAX_EVENT_ATTEMPTS,
};
