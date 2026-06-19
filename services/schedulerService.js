/**
 * Scheduler Service — polls for pending scheduled messages every 30 seconds
 * and sends them using the existing broadcast infrastructure.
 */
const db = require('../database/db');
const { sendBroadcastToGroups } = require('../bot/bot');
const { resolveBroadcastTargetGroups } = require('./broadcastTargetService');
const {
  DEFAULT_SCHEDULE_TIMEZONE,
  computeNextWeeklyOccurrence,
  normalizeMediaItems,
} = require('./scheduledMessageUtils');

const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds
// Hourly chat_logs retention pass (lightweight DELETE).
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;

let nextTickTimer = null;
let retentionTimer = null;
let schedulerStopped = false;
let tickRunning = false;

/**
 * Resolve target groups based on message targeting configuration.
 */
async function resolveTargetGroups(msg) {
  return resolveBroadcastTargetGroups({
    target_type: msg.target_type,
    target_driver_ids: msg.target_driver_ids,
    target_languages: msg.target_languages,
    target_active_filter: msg.target_active_filter,
  });
}

/**
 * Build the messages object for a scheduled message, respecting force_language.
 */
function buildMessages(msg) {
  const en = msg.message_text_en || '';
  const ru = msg.message_text_ru || en;
  const uz = msg.message_text_uz || en;

  if (msg.force_language) {
    // Force all groups to receive the same language version
    const forced = msg.force_language === 'ru' ? ru
      : msg.force_language === 'uz' ? uz
      : en;
    return { en: forced, ru: forced, uz: forced };
  }

  // Auto mode: each group gets its own language version
  return { en, ru, uz };
}

/**
 * Build media items array from scheduled message fields.
 */
function buildMediaItems(msg) {
  const normalized = normalizeMediaItems(msg.media_items);
  if (normalized.length > 0) return normalized;
  if (!msg.media_file_id) return null;
  return [{ file_id: msg.media_file_id, media_type: msg.media_type || 'photo' }];
}

/**
 * Process a single scheduled message.
 */
async function processMessage(msg) {
  console.log(`[SCHEDULER] Processing scheduled message id=${msg.id}`);

  try {
    const scheduleType = msg.schedule_type || 'one_time';
    const isWeeklyRecurring = scheduleType === 'weekly';
    const groups = await resolveTargetGroups(msg);

    if (groups.length === 0) {
      if (isWeeklyRecurring) {
        const nextOccurrence = computeNextWeeklyOccurrence({
          dayOfWeek: msg.weekly_day_of_week,
          timeOfDay: msg.weekly_time_local,
          timezone: msg.schedule_timezone || DEFAULT_SCHEDULE_TIMEZONE,
        });
        if (nextOccurrence) {
          await db.recordRecurringScheduledMessageRun(
            msg.id,
            nextOccurrence.toUTC().toISO(),
            'failed',
            false
          );
        } else {
          await db.updateScheduledMessageStatus(msg.id, 'failed');
        }
      } else {
        console.log(`[SCHEDULER] No groups found for message id=${msg.id}, marking as failed`);
        await db.updateScheduledMessageStatus(msg.id, 'failed');
      }
      return { sent: 0, failed: 0, status: 'failed' };
    }

    const messages = buildMessages(msg);
    const primaryText = msg.message_text_en || '';
    const mediaItems = buildMediaItems(msg);
    const mediaPosition = msg.media_position || 'above';

    const results = await sendBroadcastToGroups(
      groups,
      primaryText,
      'HTML',
      messages,
      mediaItems,
      mediaPosition
    );

    if (isWeeklyRecurring) {
      const nextOccurrence = computeNextWeeklyOccurrence({
        dayOfWeek: msg.weekly_day_of_week,
        timeOfDay: msg.weekly_time_local,
        timezone: msg.schedule_timezone || DEFAULT_SCHEDULE_TIMEZONE,
      });

      if (!nextOccurrence) {
        await db.updateScheduledMessageStatus(msg.id, 'failed');
        console.log(`[SCHEDULER] Message id=${msg.id} FAILED: invalid recurring schedule metadata`);
        return { ...results, status: 'failed' };
      }

      const runStatus = results.failed > 0 && results.sent === 0
        ? 'failed'
        : (results.failed > 0 ? 'partial' : 'sent');

      await db.recordRecurringScheduledMessageRun(
        msg.id,
        nextOccurrence.toUTC().toISO(),
        runStatus,
        results.sent > 0
      );

      console.log(
        `[SCHEDULER] Weekly message id=${msg.id} ${runStatus.toUpperCase()}: ` +
        `${results.sent} sent, ${results.failed} failed, next=${nextOccurrence.toISO()}`
      );
      return { ...results, status: runStatus, next_run_at: nextOccurrence.toUTC().toISO() };
    }

    if (results.failed > 0 && results.sent === 0) {
      await db.updateScheduledMessageStatus(msg.id, 'failed');
      console.log(`[SCHEDULER] Message id=${msg.id} FAILED: all ${results.failed} groups failed`);
      return { ...results, status: 'failed' };
    }
    await db.updateScheduledMessageStatus(msg.id, 'sent');
    console.log(`[SCHEDULER] Message id=${msg.id} SENT: ${results.sent} sent, ${results.failed} failed`);
    return { ...results, status: 'sent' };
  } catch (err) {
    console.error(`[SCHEDULER] Error processing message id=${msg.id}:`, err.message);
    if ((msg.schedule_type || 'one_time') === 'weekly') {
      const nextOccurrence = computeNextWeeklyOccurrence({
        dayOfWeek: msg.weekly_day_of_week,
        timeOfDay: msg.weekly_time_local,
        timezone: msg.schedule_timezone || DEFAULT_SCHEDULE_TIMEZONE,
      });
      if (nextOccurrence) {
        await db.recordRecurringScheduledMessageRun(
          msg.id,
          nextOccurrence.toUTC().toISO(),
          'failed',
          false
        );
        return { sent: 0, failed: 0, status: 'failed', next_run_at: nextOccurrence.toUTC().toISO() };
      }
    }
    await db.updateScheduledMessageStatus(msg.id, 'failed');
    return { sent: 0, failed: 0, status: 'failed' };
  }
}

/**
 * Main polling tick — fetch and process all due messages.
 *
 * Uses a re-entrancy guard so a slow tick (e.g. a broadcast holding the
 * Telegram rate limiter for > 30s) can't stack on top of itself and
 * double-send. Combined with the setTimeout chain in scheduleNextTick(),
 * this also prevents drift from slow ticks piling up behind setInterval().
 */
async function tick() {
  if (tickRunning) {
    // Previous tick still in flight — skip rather than overlap.
    return;
  }
  tickRunning = true;
  try {
    const pendingMessages = await db.getPendingScheduledMessages();
    if (pendingMessages.length === 0) return;

    console.log(`[SCHEDULER] Found ${pendingMessages.length} pending message(s) to send`);

    for (const msg of pendingMessages) {
      if (schedulerStopped) break;
      const locked = await db.claimScheduledMessage(msg.id);
      if (!locked) {
        console.log(`[SCHEDULER] Skipping message id=${msg.id} (already claimed by another worker)`);
        continue;
      }
      await processMessage(locked);
    }
  } catch (err) {
    console.error('[SCHEDULER] Tick error:', err.message);
  } finally {
    tickRunning = false;
  }
}

function scheduleNextTick() {
  if (schedulerStopped) return;
  nextTickTimer = setTimeout(async () => {
    await tick();
    scheduleNextTick();
  }, POLL_INTERVAL_MS);
}

/**
 * Periodic chat_logs retention pass — hard-wires the 30-day window
 * documented in the schema. Runs hourly; cheap if nothing to delete.
 */
async function retentionTick() {
  try {
    if (typeof db.deleteOldChatLogs === 'function') {
      const deleted = await db.deleteOldChatLogs(30);
      if (deleted > 0) {
        console.log(`[SCHEDULER] chat_logs retention: deleted ${deleted} row(s) older than 30 days`);
      }
    }
  } catch (err) {
    console.error('[SCHEDULER] Retention tick error:', err.message);
  }
}

/**
 * Start the scheduler service.
 */
function startScheduler() {
  console.log(`[SCHEDULER] Started — polling every ${POLL_INTERVAL_MS / 1000}s`);
  schedulerStopped = false;
  // Fire immediately on boot, then chain subsequent ticks with setTimeout
  // so a long-running tick can never pile up duplicates.
  (async () => {
    await tick();
    scheduleNextTick();
  })();
  // Kick off chat_logs retention: immediate then hourly.
  retentionTick();
  retentionTimer = setInterval(retentionTick, RETENTION_INTERVAL_MS);
}

/**
 * Stop the scheduler service.
 */
function stopScheduler() {
  schedulerStopped = true;
  if (nextTickTimer) {
    clearTimeout(nextTickTimer);
    nextTickTimer = null;
  }
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
  console.log('[SCHEDULER] Stopped.');
}

module.exports = { startScheduler, stopScheduler, tick, processMessage, retentionTick };
