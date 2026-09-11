'use strict';

/**
 * The one line a background worker adds to become visible.
 *
 * Wrap a pass and the ledger learns that it ran, when, and how it went:
 *
 *     async function tick() {
 *       if (tickRunning) return;
 *       tickRunning = true;
 *       try { await withRunRecord('fuel_risk', () => runFuelRiskCheck({})); }
 *       finally { tickRunning = false; }
 *     }
 *
 * THE WRAPPER NEVER CHANGES THE PASS'S BEHAVIOUR. It returns what the pass
 * returned, it re-throws nothing it was not given, and every one of its own
 * database writes is swallowed — a ledger that can break the worker it watches
 * is a worse problem than the one it solves.
 *
 * A pass that returns `{ skipped: … }` is recorded as `skipped`, and one that
 * returns `{ blocked: 'no Telegram destination configured' }` as `blocked` with
 * that sentence. Those are not failures and must never be rendered as failures:
 * an unconfigured feature painted red is how a real outage gets lost among
 * things nobody ever switched on.
 */
const runs = require('../../database/backgroundRuns');
const { getServiceEntry } = require('../../lib/operations/backgroundServiceCatalog');

/**
 * Read a pass's own return value for what it is saying about itself.
 *
 * Deliberately conservative: only an EXPLICIT `blocked` or `skipped` counts. A
 * pass that returns `{ checked: 0 }` has run and found nothing, which is a
 * healthy pass and the single most common outcome in this application.
 */
function statusFromSummary(summary) {
  if (!summary || typeof summary !== 'object') return { status: 'ok', error: null };
  if (summary.blocked) {
    return {
      status: 'blocked',
      error: typeof summary.blocked === 'string' ? summary.blocked : 'waiting on configuration',
    };
  }
  if (summary.error) return { status: 'error', error: String(summary.error) };
  if (summary.skipped) {
    return { status: 'skipped', error: null };
  }
  return { status: 'ok', error: null };
}

/**
 * @param {string} serviceKey  a key from `lib/operations/backgroundServiceCatalog`
 * @param {Function} pass      the work; its return value is the summary
 * @returns {Promise<*>} whatever the pass returned
 */
async function withRunRecord(serviceKey, pass) {
  const entry = getServiceEntry(serviceKey);
  const expected = entry?.expectedIntervalSeconds ?? null;
  await runs.recordRunStart(serviceKey, { expectedIntervalSeconds: expected });

  try {
    const summary = await pass();
    const { status, error } = statusFromSummary(summary);
    await runs.recordRunFinish(serviceKey, {
      status, error, summary, expectedIntervalSeconds: expected,
    });
    return summary;
  } catch (err) {
    await runs.recordRunFinish(serviceKey, {
      status: 'error', error: err?.message || String(err), expectedIntervalSeconds: expected,
    });
    // RE-THROWN, because swallowing here would change what the caller does. The
    // ledger observes; it does not decide.
    throw err;
  }
}

/**
 * For a worker with no pass to wrap — a wake timer, an event-driven drain.
 * Records that it was alive at this moment and nothing else.
 */
async function noteHeartbeat(serviceKey, { status = 'ok', detail = null, summary = null } = {}) {
  const entry = getServiceEntry(serviceKey);
  return runs.recordRunFinish(serviceKey, {
    status, error: detail, summary,
    expectedIntervalSeconds: entry?.expectedIntervalSeconds ?? null,
  });
}

module.exports = { withRunRecord, noteHeartbeat, statusFromSummary };
