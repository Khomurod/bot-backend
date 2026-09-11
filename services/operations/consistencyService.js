/**
 * The consistency sweep: load one snapshot, run every pure check over it, file
 * what disagrees.
 *
 * All the judgement lives in ./checks/*.js, which are pure functions of a
 * snapshot. This module does the three things they must not: read the database,
 * write findings, and decide what "no longer true" means.
 *
 * ONE SNAPSHOT, ONE MOMENT. Every check sees the same rows read at the same
 * time. Letting checks query independently would let two of them disagree about
 * the fleet — which is precisely the class of bug this whole feature exists to
 * find, and it would be embarrassing to ship it inside the finder.
 *
 * A CHECK THAT THREW DOES NOT RESOLVE ANYTHING. `resolveClearedFindings` is
 * given only the check keys that ran to completion, so a failure mid-sweep can
 * never be mistaken for "the problem went away" and silently clear the board.
 */
const defaultDb = require('../../database/pool');
const defaultFindingsStore = require('../../database/operationalFindings');
const identity = require('./checks/identity');
const identityLayer = require('./checks/identityLayer');
const systems = require('./checks/systems');
const homeTime = require('./checks/homeTime');
const homeTimeContinuity = require('./checks/homeTimeContinuity');
const { runAutoCorrections } = require('./corrections/autoApply');

const POLL_MS = 15 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 120 * 1000;

const CHECK_MODULES = [
  { name: 'identity', keys: identity.CHECK_KEYS, run: identity.runIdentityChecks },
  { name: 'identityLayer', keys: identityLayer.CHECK_KEYS, run: identityLayer.runIdentityLayerChecks },
  { name: 'systems', keys: systems.CHECK_KEYS, run: systems.runSystemChecks },
  { name: 'homeTime', keys: homeTime.CHECK_KEYS, run: homeTime.runHomeTimeChecks },
  { name: 'homeTimeContinuity', keys: homeTimeContinuity.CHECK_KEYS, run: homeTimeContinuity.runHomeTimeContinuityChecks },
];

let serviceTimer = null;
let serviceStopped = false;
let tickRunning = false;
let lastRun = null;
let lastCorrections = null;

/**
 * Everything the checks need, read once.
 *
 * Deliberately plain SELECTs rather than the data-layer helpers: several of
 * those auto-seed rows on read (`listDriverProfiles` creates a missing profile),
 * and a read-only sweep must not write.
 */
async function loadSnapshot(db = defaultDb) {
  const [groups, profiles, roadHistory, homeStatus, settings, exhausted, layer] = await Promise.all([
    db.query(
      `SELECT id, group_name, group_type, active, status_source, status_updated_at,
              bot_member_status, bot_access_checked_at, last_message_seen_at, samsara_vehicle_id
         FROM groups`
    ),
    db.query(
      `SELECT group_id, first_name, last_name, secondary_first_name, secondary_last_name,
              unit_number, status, telegram_user_id
         FROM driver_profiles`
    ),
    // Open cycles, plus every cycle of any group that has one — the class-B rule
    // needs a cycle's NEIGHBOURS, not just the open row itself.
    db.query(
      `SELECT id, group_id, road_started_at, home_arrived_at, return_to_road_at, home_days
         FROM driver_road_history
        WHERE group_id IN (SELECT group_id FROM driver_road_history WHERE return_to_road_at IS NULL)
        ORDER BY group_id, home_arrived_at`
    ),
    db.query('SELECT group_id, state, state_since, last_status_at, road_bonus_weeks_notified FROM driver_home_status'),
    db.query('SELECT home_allowance_days, road_allowance_weeks FROM home_time_settings WHERE id = 1'),
    // The exhausted internal-alert pile. Ids and the recorded error only — never
    // the alert BODY, which is driver correspondence and has no business in a
    // finding's evidence.
    db.query(
      `SELECT id, requested_at, internal_alert_last_error
         FROM home_time_requests
        WHERE internal_alert_state = 'failed'
        ORDER BY requested_at ASC`
    ),
    loadLayerSnapshot(db),
  ]);

  return {
    now: new Date(),
    groups: groups.rows,
    groupsById: new Map(groups.rows.map((g) => [g.id, g])),
    profiles: profiles.rows,
    roadHistory: roadHistory.rows,
    homeStatus: homeStatus.rows,
    settings: settings.rows[0] || {},
    exhaustedInternalAlerts: {
      count: exhausted.rows.length,
      oldestAt: exhausted.rows[0]?.requested_at || null,
      requestIds: exhausted.rows.map((r) => r.id),
      lastError: exhausted.rows[0]?.internal_alert_last_error || null,
    },
    ...layer,
  };
}

/**
 * The person layer and the systems that hang off it (Phase 3-F). Only what the
 * checks compare — ids, states and links; never message text or alert bodies.
 */
async function loadLayerSnapshot(db) {
  const [people, personGroups, units, fuelAlerts, teamDrivers, mileageProgress, routeAssignments, personGroupHistory] = await Promise.all([
    db.query('SELECT id, display_name, merged_into_person_id FROM driver_people'),
    db.query('SELECT person_id, group_id, started_at FROM driver_person_groups WHERE ended_at IS NULL'),
    db.query('SELECT person_id, unit_number, samsara_vehicle_id FROM driver_units WHERE ended_at IS NULL'),
    db.query(`SELECT id, group_id, status, created_at FROM fuel_stop_alerts WHERE status = 'watching'`),
    db.query(
      `SELECT id, team_id, group_id, driver_profile_id, person_id, driver_name, active
         FROM dispatch_team_drivers WHERE active = TRUE`
    ),
    db.query('SELECT id, driver_normalized_name, person_id FROM mileage_bonus_progress WHERE is_active = TRUE'),
    db.query(`SELECT id, group_id, status, created_at FROM route_assignments WHERE status = 'active'`),
    // Open AND closed: the continuity check needs to know which chat a person
    // was on BEFORE the one they are on now.
    db.query('SELECT person_id, group_id, started_at, ended_at FROM driver_person_groups ORDER BY started_at'),
  ]);
  return {
    people: people.rows,
    personGroups: personGroups.rows,
    personGroupHistory: personGroupHistory.rows,
    units: units.rows,
    fuelAlerts: fuelAlerts.rows,
    teamDrivers: teamDrivers.rows,
    mileageProgress: mileageProgress.rows,
    routeAssignments: routeAssignments.rows,
  };
}

/**
 * Run the sweep.
 *
 * @param {object} [options]
 * @param {boolean} [options.apply=true]  false = compute and return, write nothing
 * @param {object}  [options.db]          injected like every other data dependency
 */
/**
 * @param {object} [options]
 * @param {object} [options.store]  the findings data layer — injected alongside
 *   `db` for the same reason `runAutoCorrections` takes one: it holds its own
 *   pool binding, so passing a `db` without a `store` silently splits a sweep
 *   across two databases. Untestable against a throwaway database without it.
 */
async function runConsistencySweep({ apply = true, db = defaultDb, store: findingsStore = defaultFindingsStore } = {}) {
  const snapshot = await loadSnapshot(db);

  const findings = [];
  const completedKeys = [];
  const failures = [];

  for (const mod of CHECK_MODULES) {
    try {
      findings.push(...mod.run(snapshot));
      completedKeys.push(...mod.keys);
    } catch (err) {
      // One broken check must not cost the whole sweep, and must not let its
      // keys be resolved as though the conditions had cleared.
      failures.push({ module: mod.name, error: err.message });
      console.error(`[CONSISTENCY] check module "${mod.name}" failed:`, err.message);
    }
  }

  const summary = {
    scanned: {
      groups: snapshot.groups.length,
      openCycles: snapshot.roadHistory.filter((r) => !r.return_to_road_at).length,
    },
    found: findings.length,
    bySeverity: findingsStore.SEVERITIES.reduce((acc, s) => {
      acc[s] = findings.filter((f) => f.severity === s).length;
      return acc;
    }, {}),
    byTier: findingsStore.TIERS.reduce((acc, t) => {
      acc[t] = findings.filter((f) => f.tier === t).length;
      return acc;
    }, {}),
    failures,
    filed: 0,
    resolved: 0,
    dryRun: !apply,
  };

  if (!apply) {
    lastRun = { at: new Date(), summary };
    return { summary, findings };
  }

  const filedIds = [];
  for (const finding of findings) {
    const row = await findingsStore.upsertFinding(finding);
    if (row) filedIds.push(row.id);
  }
  summary.filed = filedIds.length;
  summary.resolved = await findingsStore.resolveClearedFindings(completedKeys, filedIds);

  if (summary.found || summary.resolved) {
    console.log(`[CONSISTENCY] ${summary.found} finding(s) `
      + `(${summary.bySeverity.serious} serious, ${summary.bySeverity.warning} warning), `
      + `${summary.resolved} cleared.`);
  }
  lastRun = { at: new Date(), summary };
  return { summary, findings };
}

/**
 * Run a sweep, but never two at once.
 *
 * THE GUARD IS NOT ABOUT LOAD, it is about correctness. `resolveClearedFindings`
 * closes every open finding for the checks that ran EXCEPT the ids this sweep
 * just filed. Two overlapping sweeps therefore carry two different `keepIds`
 * sets, and if the one that started FIRST commits LAST it resolves findings the
 * newer sweep had just re-filed — clearing real problems off the page until the
 * next run happens to notice them again.
 *
 * Exported because the admin's "Run checks now" button must go through the same
 * door as the timer. It returned early with no explanation before, which is why
 * an on-demand caller could walk straight past it.
 *
 * @param {boolean} [options.correct=true]  run the permitted auto-corrections
 *   after filing; ignored (never runs) when `apply` is false, because a preview
 *   that corrected would not be a preview.
 * @returns {{skipped: true, reason: string} | {summary, findings, corrections?}}
 */
async function runGuardedSweep(options = {}) {
  if (tickRunning) {
    return { skipped: true, reason: 'A sweep is already running; this one was not started.' };
  }
  tickRunning = true;
  try {
    const result = await runConsistencySweep(options);
    // Still under the guard: corrections change the rows the next sweep reads,
    // and `resolveClearedFindings` decides "no longer true" from those rows, so
    // a correction run racing a sweep is the overlap the guard exists to stop.
    if (options.apply !== false && options.correct !== false) {
      result.corrections = await runCorrectionsAfterSweep(options);
    }
    return result;
  } finally {
    // `finally`, not the success path: a sweep that throws must not wedge the
    // guard shut and stop every later one, including the timer's.
    tickRunning = false;
  }
}

/**
 * Apply what the admin has permitted, right after the findings are filed.
 *
 * This is what makes the per-check "Auto-apply" switch DO something. Until it
 * was wired here, `runAutoCorrections` was reachable only from the admin's
 * dry-run preview and a shell script, so a check an operator had explicitly
 * enabled still corrected nothing until somebody ran a command by hand.
 *
 * Every guardrail stays where it was: a check with no settings row is off, the
 * per-run cap is a COUNT, evidence is re-derived at apply time and a moved
 * timestamp refuses. The only new thing is that the timer asks.
 *
 * A failure here is recorded and returned, never thrown — the findings were
 * already filed, and losing that summary to a registry error would hide the
 * one run an operator most wants to see.
 */
async function runCorrectionsAfterSweep({ db = defaultDb, store = defaultFindingsStore } = {}) {
  const at = new Date();
  try {
    const { summary, results, capped } = await runAutoCorrections({ apply: true, db, store });
    lastCorrections = { at, summary };

    // Say what was fixed. AFTER the corrections commit, and never in a way that
    // can undo them: the engine has been changing records silently since Phase
    // 3, and "the software corrected it" is only trustworthy if you find out.
    try {
      // eslint-disable-next-line global-require
      const { announceCorrections } = require('../operations/correctionNotices');
      await announceCorrections(results.filter((r) => r.ok));
    } catch (err) {
      console.warn('[CONSISTENCY] could not announce corrections:', err.message);
    }

    return { summary, results, capped };
  } catch (err) {
    console.error('[CONSISTENCY] auto-correction run failed:', err.message);
    lastCorrections = { at, error: err.message };
    return { error: err.message };
  }
}

async function tick() {
  try {
    await runGuardedSweep();
  } catch (err) {
    console.error('[CONSISTENCY] sweep error:', err.message);
  }
  // Drain whatever could not be delivered when it happened. It rides THIS timer
  // rather than one of its own because a notice is always about something this
  // sweep just did or found, and a second timer would be a second thing to
  // notice had stopped. Its own failures are swallowed inside the sweep, so a
  // dead Telegram cannot stop the consistency pass that produced the notices.
  try {
    // eslint-disable-next-line global-require
    const { runNotificationSweep } = require('../notifications/send');
    await runNotificationSweep({ limit: 20 });
  } catch (err) {
    console.error('[CONSISTENCY] notification sweep error:', err.message);
  }
}

function startConsistencyService() {
  serviceStopped = false;
  console.log(`[CONSISTENCY] Service started — operational consistency sweep every ${POLL_MS / 60000}min`);
  setTimeout(() => { if (!serviceStopped) tick(); }, FIRST_TICK_DELAY_MS).unref?.();
  serviceTimer = setInterval(() => { if (!serviceStopped) tick(); }, POLL_MS);
  serviceTimer.unref?.();
}

function stopConsistencyService() {
  serviceStopped = true;
  if (serviceTimer) {
    clearInterval(serviceTimer);
    serviceTimer = null;
  }
}

/** For /api/health and the Operations page: did the sweep run, and what did it see. */
function getConsistencyStatus() {
  return { running: Boolean(serviceTimer), lastRun, lastCorrections };
}

module.exports = {
  POLL_MS,
  CHECK_MODULES,
  loadSnapshot,
  runConsistencySweep,
  runGuardedSweep,
  startConsistencyService,
  stopConsistencyService,
  getConsistencyStatus,
  tick,
};
