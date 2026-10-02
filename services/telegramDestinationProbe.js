/**
 * Asking Telegram about every configured destination BEFORE a send fails.
 *
 * Following a move from a failed send (services/telegramChatMigration.js) only
 * works while something is still trying to send. On 2026-10-02 every notice to
 * the managers had already used its six attempts and stopped, so nothing would
 * ever have hit the error that names the new id. `getChat` on a moved group
 * answers with that same error and the same new id, so asking is enough.
 *
 * Every six hours, first two minutes after boot. Single flight. It writes
 * nothing itself; a move is applied by the migration service, audited, and
 * announced once. A destination that is merely unreachable (bot removed, chat
 * deleted) is counted and left alone — that is a person's call, and the
 * delivery-truth health check already names it.
 */
const { withRunRecord } = require('./operations/runLedger');
const chatMigration = require('./telegramChatMigration');
const { notify } = require('./notifications/send');
const { publicTelegramError } = require('../lib/operations/deliveryTruth');

const SERVICE_KEY = 'telegram_destination_probe';
const PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_PROBE_DELAY_MS = 2 * 60 * 1000;

let timer = null;
let running = false;

function defaultDeps() {
  // eslint-disable-next-line global-require
  return { store: require('../database/telegramChatMigration'), migration: chatMigration, notify };
}

/**
 * Ask about every destination. `getChat` first: it is read-only and answers
 * for every healthy chat without anyone seeing anything. Only when it FAILS
 * is `sendChatAction` tried — a write, which for a moved group returns the
 * same "upgraded to a supergroup" error a real send does, new id included.
 * Production showed why both are needed: the first pass after this shipped
 * asked every destination and followed nothing, while every real send to the
 * managers' chat was still failing with exactly that error.
 *
 * A move found but not applied (the database refused) is NOT a clean run:
 * it is reported as an error so the ledger, the Systems tab and the
 * self-healing watch all see it, instead of a quiet "ok".
 */
async function probeOnce({ telegram, deps = defaultDeps() } = {}) {
  if (!telegram?.getChat) return { blocked: 'no Telegram client to ask' };
  const ids = await deps.store.listDestinationChatIds();
  const summary = { ok: true, checked: 0, moved: 0, unreachable: 0, followFailed: 0, reasons: {} };
  const why = (err) => publicTelegramError(err?.response?.description || err?.message) || 'unknown error';
  for (const id of ids) {
    summary.checked += 1;
    let lastErr = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      await telegram.getChat(id);
      continue;
    } catch (err) { lastErr = err; }
    // eslint-disable-next-line no-await-in-loop
    let moved = await deps.migration.followMigrationFromError(lastErr, id);
    if (!moved && telegram.sendChatAction) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await telegram.sendChatAction(id, 'typing');
        // Reading refused but sending works: reachable, nothing to follow.
        const key = `read refused, sending works: ${why(lastErr)}`;
        summary.reasons[key] = (summary.reasons[key] || 0) + 1;
        continue;
      } catch (err) {
        lastErr = err;
        // eslint-disable-next-line no-await-in-loop
        moved = await deps.migration.followMigrationFromError(err, id);
      }
    }
    if (moved && !moved.summary) {
      summary.followFailed += 1;
    } else if (moved) {
      summary.moved += 1;
      const said = deps.migration.migrationNotice(moved.summary);
      if (said) Promise.resolve(deps.notify(said)).catch(() => {});
    } else {
      summary.unreachable += 1;
      const key = why(lastErr);
      summary.reasons[key] = (summary.reasons[key] || 0) + 1;
    }
  }
  if (summary.followFailed > 0) {
    summary.error = `${summary.followFailed} moved group(s) found but the move could not be applied`;
  }
  return summary;
}

function startTelegramDestinationProbe({ telegram } = {}) {
  stopTelegramDestinationProbe();
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await withRunRecord('telegram_destination_probe', () => probeOnce({ telegram }));
    } catch (err) {
      console.warn('[TG-PROBE] pass failed:', err.message);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => {
    void tick();
    timer = setInterval(() => { void tick(); }, PROBE_INTERVAL_MS);
    timer.unref?.();
  }, FIRST_PROBE_DELAY_MS);
  first.unref?.();
  timer = first;
}

function stopTelegramDestinationProbe() {
  if (!timer) return;
  clearTimeout(timer);
  clearInterval(timer);
  timer = null;
}

module.exports = {
  SERVICE_KEY, PROBE_INTERVAL_MS, FIRST_PROBE_DELAY_MS,
  probeOnce, startTelegramDestinationProbe, stopTelegramDestinationProbe,
};
