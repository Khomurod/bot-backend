/**
 * Auto-applying Tier 1 corrections, under three guardrails.
 *
 * The guardrails are the reason this is allowed to exist at all, so each is
 * stated with the failure it prevents:
 *
 *   PER-CHECK PERMISSION, DEFAULT DENY. A check with no row in
 *   `operational_check_settings` is disabled. "The system may close home-time
 *   cycles from recorded evidence" and "the system may change a driver's status"
 *   are different decisions, and one global switch would force an operator to
 *   accept both to get either.
 *
 *   DRY RUN FIRST. `runAutoCorrections()` computes and returns without writing
 *   unless `apply: true`. The plan it returns is exactly what applying would do,
 *   so an operator can read it before granting anything.
 *
 *   A CAP PER RUN. A check that suddenly wants to change hundreds of rows has
 *   almost certainly found a bug in itself rather than hundreds of real
 *   problems. It stops, changes nothing, and files a `serious` finding about its
 *   own behaviour — which is the outcome that would have caught this class of
 *   mistake before it reached a fleet.
 *
 * THE CAP IS DECIDED BY A COUNT, NOT BY A PAGE OF ROWS. Asking for the findings
 * and measuring what came back cannot tell "exactly the cap" from "the cap and
 * an unknown number more", so at the top of the range — cap 500, 501 eligible —
 * the guardrail would have read a truncated page as compliant and applied 500
 * corrections instead of refusing. The batch counts first and lists second.
 *
 * A stale proposal is skipped, never forced: if a human fixed the row by hand in
 * the minutes since the sweep, or edited the evidence it was built from, the
 * action raises StaleCorrectionError and it is counted as skipped. Being second
 * to a person is a success, not an error.
 */
const defaultDb = require('../../../database/pool');
const defaultStore = require('../../../database/operationalFindings');
const { actionForCheck, CHECK_TO_ACTION } = require('./actions');
const { applyCorrection, StaleCorrectionError } = require('./apply');

const DEFAULT_CAP = 50;

/**
 * A settings row's mode, tolerant of a row that predates migration 0044.
 *
 * The SQL already COALESCEs, but `loadCheckSettings` is injectable — several
 * suites hand this module a fake db whose rows carry only the old boolean —
 * and a row written before 0044 has the same shape. Resolving it here rather
 * than only in the query means there is ONE answer to "what mode is this
 * check in", wherever the row came from.
 */
function modeOf(setting) {
  if (!setting) return null;
  if (setting.mode) return setting.mode;
  return setting.auto_apply_enabled === true ? 'autopilot' : 'suggest';
}

/** Per-check settings, keyed by check_key. Absent = disabled. */
async function loadCheckSettings(db = defaultDb) {
  // `mode` IS THE AUTHORITY, not `auto_apply_enabled`. The boolean is kept for
  // older readers and cannot be trusted to have been updated alongside; nothing
  // that ACTS reads it. COALESCE covers a row written before migration 0044 by
  // something that never learned about modes.
  // BOTH are returned: `mode` because it is what this module acts on, and
  // `auto_apply_enabled` because the row is read elsewhere and a field silently
  // dropped is its own kind of defect. `modeOf` decides which one wins.
  const res = await db.query(
    `SELECT check_key, max_auto_per_run, shadow, auto_apply_enabled,
            COALESCE(mode, CASE WHEN auto_apply_enabled THEN 'autopilot' ELSE 'suggest' END)
              AS mode
       FROM operational_check_settings`
  );
  return new Map(res.rows.map((r) => [r.check_key, r]));
}

/**
 * Turn a finding into the payload its action needs.
 *
 * Reads ONLY the finding's own `proposedChange`, which the pure check built from
 * recorded evidence. Nothing is recomputed here — the action itself re-derives
 * the answer from the live rows before it writes anything, which is where a
 * proposal that has gone stale is caught.
 */
/**
 * A finding's proposed change → the arguments its action takes.
 *
 * BOTH `POST /findings/:id/apply` and `runAutoCorrections` come through here, so
 * a check key this function does not know has a registered action that can never
 * run: the route answers "no proposed change" and the batch counts it under
 * `skipped.noPayload`. Registering an action is half of wiring it up; this is
 * the other half.
 */
function payloadFor(finding) {
  const change = finding.proposedChange || {};
  if (finding.checkKey === 'home_time.closable_open_cycle') {
    return {
      cycleId: change.id,
      returnToRoadAt: change.returnToRoadAt?.to ?? null,
      homeDays: change.homeDays?.to ?? null,
    };
  }
  if (finding.checkKey === 'identity.status_disagreement') {
    return { groupId: change.groupId, toStatus: change.to };
  }
  if (finding.checkKey === 'identity.group_without_person') {
    return change.groupId ? { groupId: change.groupId } : null;
  }
  if (finding.checkKey === 'home_time.clock_reset_on_group_change') {
    return change.groupId && change.to
      ? {
        groupId: change.groupId, fromStateSince: change.from, toStateSince: change.to,
        fromGroupId: change.fromGroupId, personId: change.personId ?? null,
        roadBonusWeeksNotified: change.roadBonusWeeksNotified?.to ?? null,
      }
      : null;
  }
  if (finding.checkKey === 'identity.stale_unit_assignment') {
    return change.personId && change.to
      ? { personId: change.personId, unitNumber: change.to, groupId: change.groupId }
      : null;
  }
  if (finding.checkKey === 'home_time.returned_to_road') {
    return change.groupId && change.returnToRoadAt
      ? {
        groupId: change.groupId,
        returnToRoadAt: change.returnToRoadAt,
        evidenceSummary: change.evidenceSummary || null,
      }
      : null;
  }
  if (finding.checkKey === 'home_time.exhausted_internal_alerts') {
    // Empty is NO payload, not an empty one: the batch then counts it under
    // `skipped.noPayload` rather than calling an action with nothing to do.
    const ids = Array.isArray(change.requestIds) ? change.requestIds : [];
    return ids.length ? { requestIds: ids } : null;
  }
  return null;
}

/**
 * Everything the batch would do for one check, or why it will do nothing.
 *
 * Driven by the ACTION REGISTRY rather than by the settings table, so a check
 * nobody has an opinion about still gets counted as "waiting for permission"
 * instead of vanishing from the report.
 */
async function planForCheck(checkKey, { settings, store }) {
  const action = actionForCheck(checkKey);
  const setting = settings.get(checkKey);
  const cap = (setting && setting.max_auto_per_run) || DEFAULT_CAP;

  if (!setting || modeOf(setting) !== 'autopilot') {
    return { disabled: await store.countFindings({ status: 'open', checkKey, tier: 'auto' }) };
  }

  // SHADOW DECIDES EVERYTHING AND APPLIES NOTHING. Reported separately from
  // `disabled`, because they are different answers to different questions: a
  // disabled check was never trusted, and a shadowed one is being TRIED — the
  // whole point is to find out what it would have done before letting it. One
  // bucket for both would make the trial invisible, which is the trial's only
  // output.
  if (setting.shadow === true) {
    return { shadowed: await store.countFindings({ status: 'open', checkKey, tier: 'auto' }) };
  }

  // Count, then list — see the header. `wanted` is the real number, so the
  // finding a capped check files about itself says something true.
  const wanted = await store.countFindings({ status: 'open', checkKey, tier: 'auto' });
  if (wanted > cap) return { capped: { checkKey, wanted, cap } };

  const found = await store.listFindings({
    status: 'open', checkKey, tier: 'auto', limit: cap + 1,
  });
  const items = [];
  let noPayload = 0;
  for (const finding of found) {
    const payload = payloadFor(finding);
    if (!payload) { noPayload += 1; continue; }
    items.push({ finding, action, payload });
  }
  // Re-assert against the page itself: a finding can appear between the count
  // and the list, and the cap is not a suggestion.
  if (items.length > cap) return { capped: { checkKey, wanted: items.length, cap }, noPayload };
  return { items, noPayload };
}

/**
 * @param {object} [options]
 * @param {boolean} [options.apply=false]  false = dry run, write nothing
 * @param {object}  [options.db]     { pool, query }
 * @param {object}  [options.store]  the findings data layer — injected alongside
 *   `db` because it holds its own pool binding; passing one without the other
 *   would silently split a single run across two databases.
 */
async function runAutoCorrections({ apply = false, db = defaultDb, store = defaultStore } = {}) {
  const settings = await loadCheckSettings(db);

  const plan = [];
  const capped = [];
  // `shadowed` is its own count, never folded into `disabled`. A check being
  // TRIED and a check nobody trusts are different states, and the trial's only
  // output is the number it would have changed.
  const skipped = { disabled: 0, shadowed: 0, noAction: 0, noPayload: 0 };

  for (const checkKey of CHECK_TO_ACTION.keys()) {
    const result = await planForCheck(checkKey, { settings, store });
    skipped.disabled += result.disabled || 0;
    skipped.shadowed += result.shadowed || 0;
    skipped.noPayload += result.noPayload || 0;
    if (result.capped) capped.push(result.capped);
    if (result.items) plan.push(...result.items);
  }

  // A settings row granting auto-apply to a check no action answers grants
  // nothing. Worth saying out loud rather than ignoring: it is usually a typo.
  for (const [checkKey, setting] of settings) {
    if (modeOf(setting) === 'autopilot' && !actionForCheck(checkKey)) skipped.noAction += 1;
  }

  const summary = {
    open: await store.countFindings({ status: 'open' }),
    eligible: plan.length,
    skipped,
    capped,
    applied: 0,
    stale: 0,
    failed: 0,
    dryRun: !apply,
  };

  if (!apply) {
    return {
      summary,
      plan: plan.map((p) => ({
        findingId: p.finding.id,
        checkKey: p.finding.checkKey,
        actionKey: p.action.key,
        describe: p.action.describe(p.payload),
        payload: p.payload,
      })),
      capped,
    };
  }

  // A capped check files a finding ABOUT ITSELF, so the stall is visible rather
  // than silently doing nothing every sweep from now on.
  for (const c of capped) {
    await store.upsertFinding({
      checkKey: 'operations.auto_apply_capped',
      subjectType: 'check',
      subjectId: c.checkKey,
      title: `${c.checkKey} wanted to auto-apply ${c.wanted} corrections (cap ${c.cap}) — nothing was applied`,
      severity: 'serious',
      tier: 'warning',
      evidence: { checkKey: c.checkKey, wanted: c.wanted, cap: c.cap },
    });
  }

  const results = [];
  for (const item of plan) {
    try {
      const correction = await applyCorrection({
        actionKey: item.action.key,
        payload: item.payload,
        finding: item.finding,
        db,
      });
      summary.applied += 1;
      results.push({
        findingId: item.finding.id,
        correctionId: correction.id,
        // Carried so the caller can say what happened without re-reading the
        // row: a notice about a correction should not cost a second query.
        actionKey: item.action.key,
        subjectType: correction.subject_type,
        subjectId: correction.subject_id,
        ok: true,
      });
    } catch (err) {
      if (err instanceof StaleCorrectionError || err.stale) {
        // Somebody fixed it first, or the evidence moved. That is the system working.
        summary.stale += 1;
        results.push({ findingId: item.finding.id, ok: false, stale: true, error: err.message });
        continue;
      }
      summary.failed += 1;
      results.push({ findingId: item.finding.id, ok: false, error: err.message });
      console.error(`[CORRECTIONS] ${item.action.key} on finding ${item.finding.id} failed:`, err.message);
    }
  }

  if (summary.applied || summary.failed || capped.length) {
    console.log(`[CORRECTIONS] applied ${summary.applied}, stale ${summary.stale}, `
      + `failed ${summary.failed}, capped checks ${capped.length}.`);
  }
  return { summary, results, capped };
}

module.exports = {
  DEFAULT_CAP, runAutoCorrections, loadCheckSettings, payloadFor, planForCheck,
};
