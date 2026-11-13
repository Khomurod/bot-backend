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
 *     tell the owner (services/activityLog/failureNotice.js).
 *
 * `recordAttempt` is for an attempt that never reached Bitrix — the status
 * sync's own guards — which the owner wants in the same timeline.
 */

const { bitrixWriteEntry, attemptEntry } = require('../../lib/activityLog/entry');

const warnedNoContext = new Set();

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    store: require('../../database/activityLog'),
    afterFailure: (trigger) => require('./failureNotice').checkFailureStreak(trigger),
  };
  /* eslint-enable global-require */
}

async function save(entry, deps) {
  let saved = null;
  try {
    saved = await deps.store.insertEntry(entry);
  } catch (err) {
    console.warn(`[ACTIVITY-LOG] could not record ${entry.action} (${entry.result}):`, String(err?.message || err).slice(0, 160));
    return null;
  }
  if ((entry.result === 'failed' || entry.result === 'refused') && entry.trigger && typeof deps.afterFailure === 'function') {
    try {
      await deps.afterFailure(entry.trigger);
    } catch (err) {
      console.warn('[ACTIVITY-LOG] failure-streak check failed:', String(err?.message || err).slice(0, 160));
    }
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
 * An attempt that never reached Bitrix (a guard refused it, or it was already
 * done). Never throws.
 * @param {{action: string, targetType?: string, targetId?: *, audit: object,
 *   result: 'refused'|'failed'|'already_done'|'done', error?: string}} attempt
 */
async function recordAttempt(attempt, deps = defaultDeps()) {
  try {
    return await save(attemptEntry(attempt || {}), deps);
  } catch (err) {
    console.warn('[ACTIVITY-LOG] could not build an entry:', String(err?.message || err).slice(0, 160));
    return null;
  }
}

module.exports = { recordBitrixWrite, recordAttempt, __resetWarningsForTests: () => warnedNoContext.clear() };
