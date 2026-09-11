'use strict';

/**
 * Deleting what nobody will read again.
 *
 * WHY THIS EXISTS. An audit of every table this project added found prune
 * functions that were WRITTEN AND NEVER CALLED. `pruneOldSafetyEvents` has a
 * 180-day window, a test, and no caller anywhere in `services/`, `server/` or
 * `scripts/`. `pruneAiCallLog` has one caller and it is a test file. Several
 * newer tables had no prune at all and grow on every tick: an operational
 * notice per distinct notice key, a coaching row per coached driver, a
 * correction row per applied correction, and — the largest — one
 * `operational_findings` row per load order ever seen, because resolving a
 * finding only updates its status and never deletes it.
 *
 * None of that is urgent at this fleet's size, which is exactly why it would
 * have gone unnoticed until a free-tier database filled up on a Sunday.
 *
 * IT RIDES THE SCHEDULER'S EXISTING HOURLY RETENTION TICK rather than arming a
 * timer of its own. A second timer is a second thing that can stop without
 * anybody noticing, and the whole rest of this work is about not having those.
 *
 * WHAT IT REFUSES TO DELETE, and why each is deliberate:
 *
 *   AN OPEN finding or an UNDELIVERED notice. Age is not resolution. A finding
 *   nobody has dealt with in ninety days is a worse problem than a large table,
 *   and deleting it would make the problem invisible rather than solved.
 *
 *   `driver_road_history`, `home_time_requests`, `driver_people`, `driver_units`
 *   and anything else that is a record ABOUT A PERSON. A driver's history is
 *   the thing this whole project exists to keep continuous across truck and
 *   group changes; a retention pass that trimmed it would quietly undo that.
 *
 *   `operational_corrections`. The audit trail of every change Wenze made to a
 *   real record, and the only thing a revert can be built from. It grows by a
 *   row per applied correction, which is a rate a person controls.
 */

const DEFAULT_WINDOWS = Object.freeze({
  /** Safety events: enough for a season's pattern, which is what coaching reads. */
  safetyEventDays: 180,
  /** Coaching sent: the record of what a driver was actually told. */
  coachingDays: 365,
  /** AI calls: provider, model, latency and outcome. No prompts, no answers. */
  aiCallLogDays: 30,
  /** RESOLVED findings only. An open one is never touched, at any age. */
  resolvedFindingDays: 60,
  /** DELIVERED or ABANDONED notices only. A pending one is never touched. */
  finishedNoticeDays: 90,
  /** Resolved duplicate-unit reports, which the newer findings engine supersedes. */
  resolvedReportDays: 90,
  /** `service_runs` idempotency keys: one row per service per run key, forever. */
  serviceRunDays: 30,
});

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    query: require('../../database/pool').query,
    safety: require('../../database/driverSafety'),
    aiCallLog: require('../../database/aiCallLog'),
  };
  /* eslint-enable global-require */
}

/**
 * One pass. NEVER THROWS, and each table is attempted on its own so a table
 * that does not exist yet costs that one deletion rather than all of them.
 *
 * @returns {Promise<{deleted: object, errors: string[]}>}
 */
async function runDataRetentionPass({ windows = {}, deps = defaultDeps() } = {}) {
  const w = { ...DEFAULT_WINDOWS, ...windows };
  const deleted = {};
  const errors = [];

  const attempt = async (name, fn) => {
    try {
      deleted[name] = (await fn()) || 0;
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  };

  const sql = async (text, values) => {
    const res = await deps.query(text, values);
    return res.rowCount || 0;
  };

  await attempt('safetyEvents', () => deps.safety.pruneOldSafetyEvents({ keepDays: w.safetyEventDays }));
  await attempt('aiCallLog', () => deps.aiCallLog.pruneAiCallLog(w.aiCallLogDays));

  await attempt('coaching', () => sql(
    `DELETE FROM driver_safety_coaching WHERE sent_at < NOW() - ($1 || ' days')::interval`,
    [String(w.coachingDays)]
  ));

  // RESOLVED ONLY, and the condition is stated twice over — by status and by
  // `resolved_at` being set — because a status vocabulary that gains a word
  // later must not silently start deleting open work.
  await attempt('findings', () => sql(
    `DELETE FROM operational_findings
      WHERE status IN ('resolved', 'dismissed')
        AND resolved_at IS NOT NULL
        AND resolved_at < NOW() - ($1 || ' days')::interval`,
    [String(w.resolvedFindingDays)]
  ));

  // DELIVERED or ABANDONED only. A pending notice is somebody's alarm that has
  // not gone off yet.
  await attempt('notices', () => sql(
    `DELETE FROM operational_notifications
      WHERE state IN ('delivered', 'abandoned')
        AND created_at < NOW() - ($1 || ' days')::interval`,
    [String(w.finishedNoticeDays)]
  ));

  await attempt('duplicateUnitReports', () => sql(
    `DELETE FROM duplicate_unit_reports
      WHERE status = 'resolved' AND resolved_at IS NOT NULL
        AND resolved_at < NOW() - ($1 || ' days')::interval`,
    [String(w.resolvedReportDays)]
  ));

  // Idempotency keys for jobs that have long since run. `group_status_ai` alone
  // writes one per hour.
  await attempt('serviceRuns', () => sql(
    `DELETE FROM service_runs WHERE ran_at < NOW() - ($1 || ' days')::interval`,
    [String(w.serviceRunDays)]
  ));

  return { deleted, errors };
}

module.exports = { DEFAULT_WINDOWS, defaultDeps, runDataRetentionPass };
