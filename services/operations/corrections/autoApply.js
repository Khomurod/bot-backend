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
const { takeDecision } = require('../../decisions/journal');
const { MIN_CONFIDENCE, recordDecisionFor } = require('./decisionSeam');

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
  if (finding.checkKey === 'identity.telegram_link'
      || finding.checkKey === 'identity.telegram_member_unnamed') {
    // The unnamed case has no proposal of its own — a person approving it is
    // approving THE candidate the check saw, so the payload is rebuilt from the
    // evidence and the apply re-derives it anyway.
    return change.personId && change.telegramUserId
      ? { groupId: change.groupId, personId: change.personId, telegramUserId: change.telegramUserId }
      : null;
  }
  if (finding.checkKey === 'identity.non_driver_typed_as_driver') {
    return change.groupId || finding.evidence?.groupId
      ? { groupId: change.groupId || finding.evidence.groupId, toType: 'company' }
      : null;
  }
  if (finding.checkKey === 'board.person_link' || finding.checkKey === 'board.person_link_suggested') {
    // The row key, not an integer id: `board_row` is the one subject type in
    // the registry that is not numeric.
    return change.rowKey && change.personId
      ? { rowKey: change.rowKey, personId: change.personId, linkSource: change.linkSource || 'board' }
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
    // AND IT LISTS THEM, because a count is not the trial's output. This
    // returned a bare number and read nothing, so a shadowed check recorded
    // NOTHING about what it would have done — the one thing shadow mode exists
    // to produce. The items go to the journal as `would have` rows and no
    // further.
    // COUNT FIRST, LIKE THE REAL RUN. Listing with a LIMIT made `shadowed`
    // under-report the total and recorded over-cap rows as actions it would
    // have taken — but once shadow is switched off the same check would be
    // CAPPED and apply nothing. A trial that does not describe the run it
    // simulates is worse than no trial: its only output is what would happen.
    const wantedShadow = await store.countFindings({ status: 'open', checkKey, tier: 'auto' });
    if (wantedShadow > cap) {
      return { shadowed: wantedShadow, capped: { checkKey, wanted: wantedShadow, cap } };
    }
    const shadowFindings = await store.listFindings({
      status: 'open', checkKey, tier: 'auto', limit: cap + 1,
    });
    const shadowItems = [];
    for (const finding of shadowFindings) {
      const payload = payloadFor(finding);
      if (payload) shadowItems.push({ finding, action, payload, mode: modeOf(setting) });
    }
    return { shadowed: wantedShadow, shadowItems };
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
    items.push({ finding, action, payload, mode: modeOf(setting) });
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
async function runAutoCorrections({
  apply = false, db = defaultDb, store = defaultStore, deps = {},
} = {}) {
  // Injected rather than destructured at module load, so a test can replace
  // either without reaching into another module's exports — reassigning
  // `apply.applyCorrection` does nothing once this file has destructured it,
  // which is a trap worth closing rather than documenting.
  const takeDecisionFn = deps.takeDecision || takeDecision;
  const applyCorrectionFn = deps.applyCorrection || applyCorrection;
  const settings = await loadCheckSettings(db);

  const plan = [];
  // What a shadowed check WOULD have done. Never applied; recorded.
  const shadowPlan = [];
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
    if (result.shadowItems) shadowPlan.push(...result.shadowItems);
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
    // REFUSED BY THE EVIDENCE, not by permission. Its own count because
    // "the owner has not enabled this" and "the owner enabled it and the
    // evidence did not support it this time" are different sentences, and
    // folding them together would hide the second entirely.
    held: 0,
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

  // ── what a shadowed check would have done ────────────────────────────────
  //
  // Recorded and not applied. `mayAct` is false in shadow however good the
  // evidence — the journal enforces that, not this loop, so a caller cannot
  // forget it.
  for (const item of shadowPlan) {
    await recordDecisionFor(item, { shadow: true, takeDecision: takeDecisionFn })
      .catch(() => null);
  }

  const results = [];
  for (const item of plan) {
    // THE DECISION, BEFORE THE ACTION. Recorded whatever it says, including
    // when it says do nothing — the holds and the "I do not know yet"s are
    // exactly the rows a caller has no other reason to write down, and exactly
    // the ones outcome learning needs.
    //
    // A JOURNAL THAT CANNOT WRITE MUST NOT STOP A CORRECTION. `takeDecision`
    // already swallows its own storage failures, and this catches anything
    // else: the fallback permits the action, because the guardrails that
    // actually protect this fleet — per-check permission, the cap, the live
    // re-derivation under FOR UPDATE — all still hold, and a database blip
    // silently turning off every automatic repair would be a worse failure
    // than an unrecorded one.
    const decision = await recordDecisionFor(item, { shadow: false, takeDecision: takeDecisionFn })
      .catch((err) => {
        console.warn(`[CORRECTIONS] decision not recorded for finding ${item.finding.id}:`,
          err.message);
        return { mayAct: true, verdict: 'act', reason: 'the journal could not be reached' };
      });

    if (!decision.mayAct) {
      summary.held += 1;
      results.push({
        findingId: item.finding.id,
        ok: false,
        held: true,
        verdict: decision.verdict,
        error: decision.reason,
      });
      continue;
    }

    try {
      const correction = await applyCorrectionFn({
        actionKey: item.action.key,
        payload: item.payload,
        finding: item.finding,
        db,
      });
      summary.applied += 1;
      // What was done, against the decision that permitted it. Separate from
      // the decision because the decision comes first and the action can still
      // fail — and the verification pass grades this row later.
      await decision.acted?.(item.action.key, correction.id);
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

  // `held` is in the condition as well as the message. A batch that held
  // everything it was asked to do would otherwise log exactly as quietly as one
  // with nothing to do, which is the ambiguity this whole phase exists to
  // remove.
  if (summary.applied || summary.failed || summary.held || capped.length) {
    console.log(`[CORRECTIONS] applied ${summary.applied}, held ${summary.held}, `
      + `stale ${summary.stale}, failed ${summary.failed}, capped checks ${capped.length}.`);
  }
  return { summary, results, capped };
}

module.exports = {
  DEFAULT_CAP, runAutoCorrections, loadCheckSettings, payloadFor, planForCheck,
};
