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
 * A stale proposal is skipped, never forced: if a human fixed the row by hand in
 * the minutes since the sweep, the action raises StaleCorrectionError and it is
 * counted as skipped. Being second to a person is a success, not an error.
 */
const defaultDb = require('../../../database/pool');
const defaultStore = require('../../../database/operationalFindings');
const { actionForCheck } = require('./actions');
const { applyCorrection, StaleCorrectionError } = require('./apply');

const DEFAULT_CAP = 50;

/** Per-check settings, keyed by check_key. Absent = disabled. */
async function loadCheckSettings(db = defaultDb) {
  const res = await db.query(
    'SELECT check_key, auto_apply_enabled, max_auto_per_run FROM operational_check_settings'
  );
  return new Map(res.rows.map((r) => [r.check_key, r]));
}

/**
 * Turn a finding into the payload its action needs.
 *
 * Reads ONLY the finding's own `proposedChange`, which the pure check built from
 * recorded evidence. Nothing is recomputed here — if the proposal is wrong, the
 * check is wrong, and that is a fixable place to be wrong.
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
  return null;
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
  const open = await store.listFindings({ status: 'open', limit: 500 });

  const eligible = [];
  const skipped = { notAuto: 0, noAction: 0, disabled: 0, noPayload: 0 };

  for (const finding of open) {
    if (finding.tier !== 'auto') { skipped.notAuto += 1; continue; }
    const action = actionForCheck(finding.checkKey);
    if (!action) { skipped.noAction += 1; continue; }
    const setting = settings.get(finding.checkKey);
    if (!setting || setting.auto_apply_enabled !== true) { skipped.disabled += 1; continue; }
    const payload = payloadFor(finding);
    if (!payload) { skipped.noPayload += 1; continue; }
    eligible.push({ finding, action, payload, cap: setting.max_auto_per_run || DEFAULT_CAP });
  }

  // Group by check so the cap is per check, not shared across all of them.
  const byCheck = new Map();
  for (const item of eligible) {
    if (!byCheck.has(item.finding.checkKey)) byCheck.set(item.finding.checkKey, []);
    byCheck.get(item.finding.checkKey).push(item);
  }

  const plan = [];
  const capped = [];
  for (const [checkKey, items] of byCheck) {
    const cap = items[0].cap;
    if (items.length > cap) {
      capped.push({ checkKey, wanted: items.length, cap });
      continue; // change NOTHING for this check — see the header.
    }
    plan.push(...items);
  }

  const summary = {
    open: open.length,
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
      results.push({ findingId: item.finding.id, correctionId: correction.id, ok: true });
    } catch (err) {
      if (err instanceof StaleCorrectionError || err.stale) {
        // Somebody fixed it first. That is the system working.
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

module.exports = { DEFAULT_CAP, runAutoCorrections, loadCheckSettings, payloadFor };
