'use strict';

/**
 * Turning recorded driver messages into the annotations retention reads.
 *
 * `services/aiAnnotationService.js` already classifies a message — intent
 * (`quit_signal`, `complaint`, …), sentiment, language — and writes
 * `chat_message_annotations`. Until now it ran only on demand, when somebody
 * generated an AI report, because there was nothing to annotate: driver
 * messages were not recorded. Now they are (migration 0065), and the
 * retention watch needs the answers without anybody opening a report.
 *
 * BOUNDED: at most `PER_PASS` messages per pass, oldest first, every 15
 * minutes. A backlog drains over several passes rather than one long burst of
 * model calls, and in order, so nothing is overtaken until it expires.
 *
 * SWITCHED OFF IS SAID AS SUCH. With capture off this reports `blocked`, not a
 * healthy pass that found nothing — the difference /api/health exists to tell.
 */
const { withRunRecord } = require('../operations/runLedger');

const POLL_MS = 15 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 3 * 60 * 1000;
/** Ten model calls of twelve messages. */
const PER_PASS = 120;
/** Older than this is past caring: the retention window is 30 days, but a message
 *  unannotated for three days was missed while capture or AI was down. */
const HOURS_BACK = 72;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    settings: require('../../database/chatCaptureSettings'),
    db: require('../../database/pool'),
    annotate: require('../aiAnnotationService').annotateChatLogs,
    isAiAvailable: require('../ai/registry').isAiAvailable,
  };
  /* eslint-enable global-require */
}

async function runChatAnnotationPass({ deps = defaultDeps() } = {}) {
  const settings = await deps.settings.getChatCaptureSettings();
  if (!settings.enabled) {
    return { blocked: 'driver messages are not being recorded (switched off)', found: 0, annotated: 0 };
  }
  // AI SWITCHED OFF IS A SETTING, NOT A FAULT. Without this the annotator
  // found waiting messages, annotated none and reported a failure every pass.
  if (deps.isAiAvailable && !(await deps.isAiAvailable().catch(() => false))) {
    return { blocked: 'AI is switched off or no provider is configured', found: 0, annotated: 0 };
  }
  const res = await deps.db.query(
    `SELECT cl.id, cl.group_id, cl.sender_name, cl.message_text, cl.created_at, g.group_name
       FROM chat_logs cl
       JOIN groups g ON g.id = cl.group_id
       LEFT JOIN chat_message_annotations a ON a.chat_log_id = cl.id
      WHERE cl.created_at >= NOW() - ($1 || ' hours')::interval
        AND a.chat_log_id IS NULL
      -- OLDEST FIRST. Newest-first starved a backlog: with more than a pass's
      -- worth arriving, the overflow stayed behind each new batch until it fell
      -- out of the 72-hour window unread.
      ORDER BY cl.created_at ASC
      LIMIT $2`,
    [String(HOURS_BACK), PER_PASS]
  );
  const rows = res.rows || [];
  if (!rows.length) return { found: 0, annotated: 0 };
  const annotated = await deps.annotate(rows);
  return {
    found: rows.length,
    annotated,
    // Messages waiting and NONE annotated is the AI not answering, not a quiet
    // day — the field the run ledger reads as a failure.
    ...(annotated === 0 ? { error: `none of ${rows.length} recorded driver messages could be annotated` } : {}),
  };
}

let timer = null;
let stopped = false;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    await withRunRecord('chat_annotation', () => runChatAnnotationPass({}));
  } catch (err) {
    console.error('[CHAT-ANNOTATE] pass failed:', err.message);
  } finally {
    running = false;
  }
}

function startChatAnnotator() {
  stopped = false;
  setTimeout(() => { if (!stopped) tick(); }, FIRST_TICK_DELAY_MS).unref?.();
  timer = setInterval(() => { if (!stopped) tick(); }, POLL_MS);
  timer.unref?.();
}

function stopChatAnnotator() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  POLL_MS, PER_PASS, HOURS_BACK, runChatAnnotationPass, startChatAnnotator, stopChatAnnotator,
};
