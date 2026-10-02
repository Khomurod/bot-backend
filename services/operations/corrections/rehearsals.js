'use strict';

/**
 * Writing down what a check in Suggest mode would have done.
 *
 * WHY THIS EXISTS. The learning pass proposes Autopilot for a check that has
 * practised well (`lib/operations/practiceReadiness.js`), and practice is read
 * from the decision journal. But a check in Suggest mode reached the journal
 * by one road only — the ask pass, when it put a question to the owner — and
 * the ask pass stops asking while five questions sit unanswered. Production,
 * 2026-10-02: fifteen asked, none answered, so nothing new was journalled and
 * the rehearsal record could never grow. The planner itself skipped every
 * check not on Autopilot.
 *
 * So the planner now writes them down itself. Each open `auto`-tier finding of
 * a check in SUGGEST mode is put through `takeDecision` with that mode. The
 * journal's own `applyMode` turns supported evidence into a `suggest` verdict
 * and `mayAct` is false — nothing here can change anything, and nothing reads
 * the result except the journal. Evidence that does not support acting comes
 * out `hold` or `unknown` exactly as it would on Autopilot, and that is what
 * counts as the check changing its mind.
 *
 * OBSERVE IS LEFT ALONE. The owner's word for Observe is "watch, do not even
 * ask", and the step after it is Suggest, not Autopilot. Proposing Autopilot
 * for a check nobody has yet let ask a question would skip a rung.
 *
 * BOUNDED, because this runs on the fifteen-minute sweep: at most
 * `PER_CHECK` findings per check, and at most once every `EVERY_MS`. The
 * journal upserts one row per (check, subject, verdict), so repeating a
 * subject moves its last-seen time and costs no new row.
 */
const PER_CHECK = 25;
const EVERY_MS = 6 * 3600_000;

let lastRunAt = 0;
// What the last pass that actually ran wrote — for /api/health, so whether the
// rehearsal record is growing can be read from outside. In memory: a restart
// clears it, and the first sweep after a restart runs (the clock is cleared
// too) and fills it again.
let lastResult = null;

/** For tests: forget when it last ran. */
function resetRehearsalClock() {
  lastRunAt = 0;
  lastResult = null;
}

/** @returns {{at:string, rehearsed:number, checks:number}|null} */
function getRehearsalStatus() {
  return lastResult;
}

/**
 * @param {object} args
 * @param {Map}      args.settings     per-check rows, keyed by check key
 * @param {object}   args.store        the findings data layer
 * @param {string[]} args.checkKeys    every check with a registered action
 * @param {Function} args.actionFor    checkKey → action
 * @param {Function} args.payloadFor   finding → payload | null
 * @param {Function} args.modeOf       settings row → mode | null
 * @param {Function} args.floorFor     (settings, item) → confidence floor
 * @param {Function} args.recordDecisionFor  the decision seam
 * @param {Function} args.takeDecision the journal
 * @param {number}   [args.now]
 * @returns {Promise<{rehearsed:number, checks:number, skipped?:string}>}
 *   never throws past one finding: a journal write that fails is skipped.
 */
async function recordRehearsals({
  settings, store, checkKeys, actionFor, payloadFor, modeOf, floorFor,
  recordDecisionFor, takeDecision, now = Date.now(),
}) {
  if (lastRunAt && now - lastRunAt < EVERY_MS) return { rehearsed: 0, checks: 0, skipped: 'recently' };
  lastRunAt = now;

  let rehearsed = 0;
  let checks = 0;
  for (const checkKey of checkKeys) {
    const setting = settings?.get?.(checkKey);
    if (modeOf(setting) !== 'suggest') continue;
    const action = actionFor(checkKey);
    if (!action) continue;

    // eslint-disable-next-line no-await-in-loop
    const findings = await store.listFindings({
      status: 'open', checkKey, tier: 'auto', limit: PER_CHECK,
    }).catch(() => []);
    if (!findings.length) continue;
    checks += 1;

    for (const finding of findings) {
      const payload = payloadFor(finding);
      if (!payload) continue;
      const item = { finding, action, payload, mode: 'suggest' };
      // eslint-disable-next-line no-await-in-loop
      const decision = await recordDecisionFor(item, {
        shadow: false, takeDecision, minConfidence: floorFor(settings, item),
      }).catch(() => null);
      if (decision) rehearsed += 1;
    }
  }
  lastResult = { at: new Date(now).toISOString(), rehearsed, checks };
  return { rehearsed, checks };
}

module.exports = {
  PER_CHECK, EVERY_MS, recordRehearsals, resetRehearsalClock, getRehearsalStatus,
};
