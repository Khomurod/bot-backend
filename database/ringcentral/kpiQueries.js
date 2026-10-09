/**
 * Recruiter KPI QUERIES — the I/O half of the KPI feature.
 *
 * Totals a window of calls per recruiter and hands them to the pure scorers in
 * ./kpiMath.js. Split out of database/ringcentral.js, which re-exports every
 * symbol here.
 *
 * THE TOTALS ARE ADDED UP BY POSTGRESQL (October 2026). The rollup used to
 * fetch one row per call in the window and let `summarizeCalls` count
 * directions and sum durations — on the public leaderboard's 60-second poll,
 * when the hosted database's monthly transfer allowance was nearly spent. The
 * same rules now run as `count(*) FILTER` / `sum` in one statement that returns
 * one row per recruiter. `summarizeCalls` is still the definition: the rules
 * below mirror it line for line, and tests/recruiterLeaderboardPg.test.js
 * holds the result to the old JavaScript byte for byte.
 */
const { DateTime } = require('luxon');
const { query } = require('../pool');
const { getRcConfig } = require('./settings');
const { readThroughLeaderboard } = require('./leaderboardCache');
const { resolveThresholds, buildTargets, computeRecruiterKpis } = require('./kpiMath');

// ─── KPI rollups ───

/**
 * One row per active recruiter with their totals for the window [$1, $2).
 *
 * Each rule is `summarizeCalls`, in SQL, with d = max(0, duration):
 *   - outbound / inbound: the exact direction text;
 *   - valuable talk: d >= $3 (nonValuableMaxSeconds);
 *   - non-valuable: 0 < d < $3 — a zero-length call is neither;
 *   - real / strong conversations: d >= $4 / d >= $5.
 * The LATERAL subquery aggregates with no GROUP BY, so a recruiter with no
 * calls still gets exactly one row, of zeros. Sums are float8 so they arrive as
 * JavaScript numbers exactly as the old addition produced them, with no int4
 * overflow to fail on; thresholds are float8 for the same reason.
 */
function recruiterTotalsSql({ includePhone }) {
  return `
    SELECT r.id, r.name,${includePhone ? ' r.phone_number,' : ''}
           k.total_calls, k.outbound, k.inbound, k.real_conversations, k.strong_conversations,
           k.non_valuable_calls, k.non_valuable_seconds, k.total_talk_seconds, k.valuable_talk_seconds
      FROM recruiters r
     CROSS JOIN LATERAL (
       SELECT count(*)::int AS total_calls,
              (count(*) FILTER (WHERE c.direction = 'Outbound'))::int AS outbound,
              (count(*) FILTER (WHERE c.direction = 'Inbound'))::int AS inbound,
              (count(*) FILTER (WHERE c.d >= $4::float8))::int AS real_conversations,
              (count(*) FILTER (WHERE c.d >= $5::float8))::int AS strong_conversations,
              (count(*) FILTER (WHERE c.d > 0 AND c.d < $3::float8))::int AS non_valuable_calls,
              COALESCE(sum(c.d) FILTER (WHERE c.d > 0 AND c.d < $3::float8), 0)::float8 AS non_valuable_seconds,
              COALESCE(sum(c.d), 0)::float8 AS total_talk_seconds,
              COALESCE(sum(c.d) FILTER (WHERE c.d >= $3::float8), 0)::float8 AS valuable_talk_seconds
         FROM (SELECT direction, GREATEST(duration_seconds, 0) AS d
                 FROM ringcentral_calls
                WHERE recruiter_id = r.id AND call_time >= $1 AND call_time < $2) c
     ) k
     WHERE r.active = TRUE
     ORDER BY r.name ASC, r.id ASC`;
}

/** An aggregate row as `summarizeCalls` totals — the same keys in the same order. */
function totalsFromRow(row) {
  return {
    totalCalls: row.total_calls,
    outbound: row.outbound,
    inbound: row.inbound,
    realConversations: row.real_conversations,
    strongConversations: row.strong_conversations,
    nonValuableCalls: row.non_valuable_calls,
    nonValuableSeconds: row.non_valuable_seconds,
    totalTalkSeconds: row.total_talk_seconds,
    valuableTalkSeconds: row.valuable_talk_seconds,
  };
}

/**
 * Per-recruiter KPI rollup for a UTC window (start inclusive, end exclusive).
 * Returns one entry per active recruiter (even those with zero calls) plus the
 * targets/thresholds used, so dashboards can render progress vs target.
 * `includePhone: false` is the public board's read: the number is not even
 * selected.
 */
async function rollupRecruiterKpis({ startUtc, endUtc, cfg, rangeDays, includePhone = true }) {
  const thresholds = resolveThresholds(cfg);
  const targets = buildTargets(cfg, rangeDays);

  const res = await query(recruiterTotalsSql({ includePhone }), [
    startUtc, endUtc,
    thresholds.nonValuableMaxSeconds, thresholds.realConversationMinSeconds, thresholds.strongConversationMinSeconds,
  ]);

  const recruiters = res.rows.map((row) => ({
    id: row.id,
    name: row.name,
    ...(includePhone ? { phoneNumber: row.phone_number } : {}),
    ...computeRecruiterKpis(totalsFromRow(row), targets),
  }));

  return { targets, thresholds, recruiters };
}

/**
 * Per-recruiter KPI rollup for a single day in the configured timezone.
 * dateStr null/undefined = today (dateMode "today"); otherwise "single-day".
 */
async function getRecruiterStats(dateStr, cfg, { includePhone = true } = {}) {
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
    includePhone,
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
async function getRecruiterStatsRange(startStr, endStr, cfg, { includePhone = true } = {}) {
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
    includePhone,
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

// ─── The public leaderboard ───

/** One cache entry per window the page can ask for. */
function publicWindowKey(window) {
  if (window?.mode === 'range') return `range:${window.start}:${window.end}`;
  if (window?.mode === 'single-day') return `day:${window.date}`;
  return 'today';
}

/** "Today" is only today until midnight in the zone it was computed for. */
function stillCurrent(answer) {
  return answer.dateMode !== 'today'
    || DateTime.now().setZone(answer.timezone).toISODate() === answer.date;
}

/**
 * The public contract (APP_BRIEF §4c): names and KPI numbers only — never a
 * phone number, a credential or a setting. The number is not selected for this
 * read at all; the strip below is the second lock on the same door.
 */
function toPublicStats(stats) {
  return {
    dateMode: stats.dateMode,
    date: stats.date,
    startDate: stats.startDate,
    endDate: stats.endDate,
    rangeDays: stats.rangeDays,
    timezone: stats.timezone,
    targets: stats.targets,
    thresholds: stats.thresholds,
    recruiters: stats.recruiters.map(({ phoneNumber, ...rest }) => rest),
  };
}

/**
 * The unauthenticated `/recruiters` board for one window — `{ mode: 'today' }`,
 * `{ mode: 'single-day', date }` or `{ mode: 'range', start, end }`, as the
 * route parses it — answered from ./leaderboardCache.js until something it
 * shows can have changed. Callers must not modify the returned object.
 */
async function getPublicRecruiterStats(window = { mode: 'today' }) {
  return readThroughLeaderboard(publicWindowKey(window), async () => {
    const cfg = await getRcConfig();
    const stats = window?.mode === 'range'
      ? await getRecruiterStatsRange(window.start, window.end, cfg, { includePhone: false })
      : await getRecruiterStats(window?.mode === 'single-day' ? window.date : null, cfg, { includePhone: false });
    return toPublicStats(stats);
  }, { isCurrent: stillCurrent });
}

module.exports = {
  rollupRecruiterKpis,
  getRecruiterStats,
  getRecruiterStatsRange,
  getPublicRecruiterStats,
};
