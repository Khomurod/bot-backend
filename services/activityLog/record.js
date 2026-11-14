'use strict';

/**
 * Writing the activity log (Monitoring → Logs). docs/architecture/activity-log.md.
 *
 * Both Bitrix clients call `recordBitrixWrite` AFTER each write — so a write
 * can never happen unseen, and the log can never stop one:
 *
 *   - the write has already been sent when this runs; a failed insert is
 *     logged to the console and swallowed (NOTHING HERE THROWS);
 *   - a write whose caller passed no audit context is still recorded, as
 *     `unknown`, with one console warning per method — at runtime a missing
 *     context never blocks a write (tests/activityLogCallSites.test.js keeps
 *     every call site passing one);
 *   - a write that failed or was refused looks at its feature's streak and may
 *     tell the owner (services/activityLog/failureNotice.js) — STARTED, NOT
 *     AWAITED: the write's caller (a person's button press, the status sync's
 *     loop) gets its answer as soon as the entry is in, never after a
 *     Telegram send and its rate-limit retries.
 *
 * `recordAttempt` is for an attempt that never reached Bitrix's write — a
 * safety check said no, it was already as asked, or the read before it got
 * no answer — which the owner wants in the same timeline. A safety check's
 * refusal (`safetyCheck`) is not Bitrix saying no, so it never starts the
 * streak check.
 */

const { bitrixWriteEntry, attemptEntry } = require('../../lib/activityLog/entry');

const warnedNoContext = new Set();
/** Streak checks still running — awaited by tests only (`__settledForTests`). */
const inFlight = new Set();

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    store: require('../../database/activityLog'),
    afterFailure: (trigger) => require('./failureNotice').checkFailureStreak(trigger),
  };
  /* eslint-enable global-require */
}

/** The streak check, started and left to run. Never throws, never awaited by a write. */
function startStreakCheck(trigger, deps) {
  let running;
  try {
    running = Promise.resolve(deps.afterFailure(trigger));
  } catch (err) {
    running = Promise.reject(err);
  }
  const done = running
    .catch((err) => console.warn('[ACTIVITY-LOG] failure-streak check failed:', String(err?.message || err).slice(0, 160)))
    .finally(() => inFlight.delete(done));
  inFlight.add(done);
}

async function save(entry, deps) {
  let saved = null;
  try {
    saved = await deps.store.insertEntry(entry);
  } catch (err) {
    console.warn(`[ACTIVITY-LOG] could not record ${entry.action} (${entry.result}):`, String(err?.message || err).slice(0, 160));
    return null;
  }
  const bad = entry.result === 'failed' || entry.result === 'refused';
  if (bad && !entry.safetyCheck && entry.trigger && typeof deps.afterFailure === 'function') {
    startStreakCheck(entry.trigger, deps);
  }
  return saved;
}

/**
 * One Bitrix write, after it was sent. Never throws.
 * @param {{method: string, params: object, audit?: object|null, result?: *, error?: Error|null}} write
 */
async function recordBitrixWrite(write, deps = defaultDeps()) {
  try {
    if (!write?.audit && !warnedNoContext.has(write?.method)) {
      warnedNoContext.add(write?.method);
      console.warn(`[ACTIVITY-LOG] ${write?.method} was sent without an audit context — recorded as "unknown". `
        + 'Pass { audit } from the caller (docs/architecture/activity-log.md).');
    }
    return await save(bitrixWriteEntry(write || {}), deps);
  } catch (err) {
    console.warn('[ACTIVITY-LOG] could not build an entry:', String(err?.message || err).slice(0, 160));
    return null;
  }
}

/**
 * An attempt that never reached Bitrix's write (a safety check refused it, it
 * was already done, or its read failed — spread `attemptFromError(err)`).
 * Never throws.
 * @param {{action: string, targetType?: string, targetId?: *, audit: object,
 *   result: 'refused'|'failed'|'already_done'|'done', error?: string,
 *   safetyCheck?: boolean}} attempt
 */
async function recordAttempt(attempt, deps = defaultDeps()) {
  try {
    return await save(attemptEntry(attempt || {}), deps);
  } catch (err) {
    console.warn('[ACTIVITY-LOG] could not build an entry:', String(err?.message || err).slice(0, 160));
    return null;
  }
}

module.exports = {
  recordBitrixWrite,
  recordAttempt,
  __resetWarningsForTests: () => warnedNoContext.clear(),
  __settledForTests: () => Promise.all([...inFlight]),
};
