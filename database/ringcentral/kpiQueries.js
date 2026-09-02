/**
 * Recruiter KPI QUERIES — the I/O half of the KPI feature.
 *
 * Reads call rows for a window and hands them to the pure scorers in
 * ./kpiMath.js. Split out of database/ringcentral.js, which re-exports every
 * symbol here.
 */
const { DateTime } = require('luxon');
const { query } = require('../pool');
const { getSettingsRow } = require('./settings');
const { listRecruiters } = require('./recruiters');
const {
  DEFAULT_TARGET_TALK_SECONDS, formatTalkLabel, resolveThresholds, buildTargets,
  summarizeCalls, computeRecruiterKpis,
} = require('./kpiMath');

// ─── KPI rollups ───

/**
 * Per-recruiter KPI rollup for a UTC window (start inclusive, end exclusive).
 * Returns one entry per active recruiter (even those with zero calls) plus the
 * targets/thresholds used, so dashboards can render progress vs target.
 */
async function rollupRecruiterKpis({ startUtc, endUtc, cfg, rangeDays }) {
  const thresholds = resolveThresholds(cfg);
  const targets = buildTargets(cfg, rangeDays);

  const res = await query(
    `SELECT
       r.id, r.name, r.phone_number,
       c.id AS call_id, c.direction, c.duration_seconds
     FROM recruiters r
     LEFT JOIN ringcentral_calls c
       ON c.recruiter_id = r.id
      AND c.call_time >= $1 AND c.call_time < $2
     WHERE r.active = TRUE
     ORDER BY r.name ASC, r.id ASC`,
    [startUtc, endUtc]
  );

  const byRecruiter = new Map();
  for (const row of res.rows) {
    let entry = byRecruiter.get(row.id);
    if (!entry) {
      entry = { id: row.id, name: row.name, phoneNumber: row.phone_number, calls: [] };
      byRecruiter.set(row.id, entry);
    }
    // A recruiter with zero calls in the window still yields one row (call_id NULL).
    if (row.call_id != null) {
      entry.calls.push({ direction: row.direction, durationSeconds: row.duration_seconds });
    }
  }

  const recruiters = [...byRecruiter.values()].map(({ id, name, phoneNumber, calls }) => ({
    id,
    name,
    phoneNumber,
    ...computeRecruiterKpis(summarizeCalls(calls, thresholds), targets),
  }));

  return { targets, thresholds, recruiters };
}

/**
 * Per-recruiter KPI rollup for a single day in the configured timezone.
 * dateStr null/undefined = today (dateMode "today"); otherwise "single-day".
 */
async function getRecruiterStats(dateStr, cfg) {
  const tz = cfg.timezone || 'America/Chicago';
  const day = dateStr
    ? DateTime.fromISO(dateStr, { zone: tz })
    : DateTime.now().setZone(tz);
  if (!day.isValid) throw new Error(`Invalid date: ${dateStr}`);
  const start = day.startOf('day');
  const end = start.plus({ days: 1 });

  const rollup = await rollupRecruiterKpis({
    startUtc: start.toUTC().toISO(),
    endUtc: end.toUTC().toISO(),
    cfg,
    rangeDays: 1,
  });

  const date = start.toISODate();
  return {
    dateMode: dateStr ? 'single-day' : 'today',
    date,
    startDate: date,
    endDate: date,
    rangeDays: 1,
    timezone: tz,
    ...rollup,
  };
}

/**
 * Per-recruiter KPI rollup for an inclusive date range in the configured
 * timezone. Targets scale by the number of days in the range.
 */
async function getRecruiterStatsRange(startStr, endStr, cfg) {
  const tz = cfg.timezone || 'America/Chicago';
  const startDay = DateTime.fromISO(startStr, { zone: tz });
  const endDay = DateTime.fromISO(endStr, { zone: tz });
  if (!startDay.isValid) throw new Error(`Invalid start date: ${startStr}`);
  if (!endDay.isValid) throw new Error(`Invalid end date: ${endStr}`);
  const start = startDay.startOf('day');
  const endExclusive = endDay.startOf('day').plus({ days: 1 });
  if (endExclusive <= start) throw new Error('End date must not be before start date.');
  const rangeDays = Math.round(endExclusive.diff(start, 'days').days);

  const rollup = await rollupRecruiterKpis({
    startUtc: start.toUTC().toISO(),
    endUtc: endExclusive.toUTC().toISO(),
    cfg,
    rangeDays,
  });

  return {
    dateMode: 'range',
    date: start.toISODate(),
    startDate: start.toISODate(),
    endDate: endDay.startOf('day').toISODate(),
    rangeDays,
    timezone: tz,
    ...rollup,
  };
}

module.exports = {
  rollupRecruiterKpis,
  getRecruiterStats,
  getRecruiterStatsRange,
};
