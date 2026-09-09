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
const findingsStore = require('../../database/operationalFindings');
const identity = require('./checks/identity');
const homeTime = require('./checks/homeTime');

const POLL_MS = 15 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 120 * 1000;

const CHECK_MODULES = [
  { name: 'identity', keys: identity.CHECK_KEYS, run: identity.runIdentityChecks },
  { name: 'homeTime', keys: homeTime.CHECK_KEYS, run: homeTime.runHomeTimeChecks },
];

let serviceTimer = null;
let serviceStopped = false;
let tickRunning = false;
let lastRun = null;

/**
 * Everything the checks need, read once.
 *
 * Deliberately plain SELECTs rather than the data-layer helpers: several of
 * those auto-seed rows on read (`listDriverProfiles` creates a missing profile),
 * and a read-only sweep must not write.
 */
async function loadSnapshot(db = defaultDb) {
  const [groups, profiles, roadHistory, homeStatus, settings] = await Promise.all([
    db.query(
      `SELECT id, group_name, group_type, active, status_source, status_updated_at,
              bot_member_status, bot_access_checked_at, last_message_seen_at
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
    db.query('SELECT group_id, state, state_since FROM driver_home_status'),
    db.query('SELECT home_allowance_days, road_allowance_weeks FROM home_time_settings WHERE id = 1'),
  ]);

  return {
    now: new Date(),
    groups: groups.rows,
    groupsById: new Map(groups.rows.map((g) => [g.id, g])),
    profiles: profiles.rows,
    roadHistory: roadHistory.rows,
    homeStatus: homeStatus.rows,
    settings: settings.rows[0] || {},
  };
}

/**
 * Run the sweep.
 *
 * @param {object} [options]
 * @param {boolean} [options.apply=true]  false = compute and return, write nothing
 * @param {object}  [options.db]          injected like every other data dependency
 */
async function runConsistencySweep({ apply = true, db = defaultDb } = {}) {
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
 * @returns {{skipped: true, reason: string} | {summary, findings}}
 */
async function runGuardedSweep(options = {}) {
  if (tickRunning) {
    return { skipped: true, reason: 'A sweep is already running; this one was not started.' };
  }
  tickRunning = true;
  try {
    return await runConsistencySweep(options);
  } finally {
    // `finally`, not the success path: a sweep that throws must not wedge the
    // guard shut and stop every later one, including the timer's.
    tickRunning = false;
  }
}

async function tick() {
  try {
    await runGuardedSweep();
  } catch (err) {
    console.error('[CONSISTENCY] sweep error:', err.message);
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
  return { running: Boolean(serviceTimer), lastRun };
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
