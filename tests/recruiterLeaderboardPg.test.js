/**
 * The leaderboard's totals, now added up by PostgreSQL, against the JavaScript
 * that used to add them up — on the same calls, in a real database.
 *
 * October 2026: `/recruiters` read one row per call made today on every
 * 60-second poll, so that `summarizeCalls` could count directions and sum
 * durations. The totals moved into SQL (`count(*) FILTER`, `sum`, one row per
 * recruiter). The promise is that NOTHING a viewer sees changed: the admin
 * stats and the public payload must be byte-for-byte the JSON the old code
 * produced. The old rollup is kept below, verbatim, as the reference.
 *
 * The seeded calls are chosen to break a careless aggregate: durations either
 * side of every threshold, zero and negative durations, a direction in the
 * wrong case and a NULL one, calls exactly on a day boundary, an inactive
 * recruiter's calls, unattributed calls, two recruiters with the same name and
 * one with no calls at all.
 *
 * Needs TEST_DATABASE_URL and SKIPS without it. A skipped test is not a
 * passing test (CLAUDE.md); CI fails on any skip.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const {
  resolveThresholds, buildTargets, summarizeCalls, computeRecruiterKpis,
} = require('../database/ringcentral/kpiMath');

const ALL_MIGRATIONS = allMigrationsSql();
const TZ = 'America/Chicago';

// ─── The pre-October-2026 implementation, verbatim apart from `query` ───

async function legacyRollup(query, { startUtc, endUtc, cfg, rangeDays }) {
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
    if (row.call_id != null) {
      entry.calls.push({ direction: row.direction, durationSeconds: row.duration_seconds });
    }
  }
  const recruiters = [...byRecruiter.values()].map(({ id, name, phoneNumber, calls }) => ({
    id, name, phoneNumber, ...computeRecruiterKpis(summarizeCalls(calls, thresholds), targets),
  }));
  return { targets, thresholds, recruiters };
}

async function legacyStats(query, dateStr, cfg) {
  const tz = cfg.timezone || 'America/Chicago';
  const day = dateStr ? DateTime.fromISO(dateStr, { zone: tz }) : DateTime.now().setZone(tz);
  const start = day.startOf('day');
  const end = start.plus({ days: 1 });
  const rollup = await legacyRollup(query, {
    startUtc: start.toUTC().toISO(), endUtc: end.toUTC().toISO(), cfg, rangeDays: 1,
  });
  const date = start.toISODate();
  return {
    dateMode: dateStr ? 'single-day' : 'today', date, startDate: date, endDate: date, rangeDays: 1, timezone: tz, ...rollup,
  };
}

async function legacyStatsRange(query, startStr, endStr, cfg) {
  const tz = cfg.timezone || 'America/Chicago';
  const start = DateTime.fromISO(startStr, { zone: tz }).startOf('day');
  const endDay = DateTime.fromISO(endStr, { zone: tz });
  const endExclusive = endDay.startOf('day').plus({ days: 1 });
  const rangeDays = Math.round(endExclusive.diff(start, 'days').days);
  const rollup = await legacyRollup(query, {
    startUtc: start.toUTC().toISO(), endUtc: endExclusive.toUTC().toISO(), cfg, rangeDays,
  });
  return {
    dateMode: 'range', date: start.toISODate(), startDate: start.toISODate(),
    endDate: endDay.startOf('day').toISODate(), rangeDays, timezone: tz, ...rollup,
  };
}

/** What the old route sent to the public page. */
function legacyPublic(stats) {
  return {
    dateMode: stats.dateMode, date: stats.date, startDate: stats.startDate, endDate: stats.endDate,
    rangeDays: stats.rangeDays, timezone: stats.timezone, targets: stats.targets, thresholds: stats.thresholds,
    recruiters: stats.recruiters.map(({ phoneNumber, ...rest }) => rest),
  };
}

// ─── Seed ───

const DURATIONS = [-5, 0, 1, 29, 30, 31, 59, 60, 61, 119, 120, 179, 180, 181, 599, 600, 3600];
const DIRECTIONS = ['Outbound', 'Inbound', null, 'outbound', 'Missed'];
const OWNERS = [1, 2, 4, 5, null, 1, 2];

async function seed(harness) {
  await harness.query(
    `INSERT INTO recruiters (id, name, phone_number, phone_number_normalized, active) VALUES
       (1, 'Jane', '+1 (470) 480-4679', '4704804679', TRUE),
       (2, 'Bob', '212-555-1234', '2125551234', TRUE),
       (3, 'Ann', '3125550000', '3125550000', TRUE),
       (4, 'Old', '4155550000', '4155550000', FALSE),
       (5, 'Jane', '6465550000', '6465550000', TRUE)`
  );
  await harness.query("SELECT setval(pg_get_serial_sequence('recruiters', 'id'), 10)");

  const rows = [];
  let n = 0;
  const add = (iso, i) => {
    n += 1;
    rows.push([`c${n}`, OWNERS[i % OWNERS.length], DIRECTIONS[i % DIRECTIONS.length], DURATIONS[i % DURATIONS.length], iso]);
  };
  const days = ['2026-06-28', '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-05'];
  const today = DateTime.now().setZone(TZ).startOf('day');
  for (const [d, base] of [...days.map((iso) => [iso, DateTime.fromISO(iso, { zone: TZ })]), ['today', today]]) {
    for (let i = 0; i < 40; i += 1) add(base.plus({ minutes: 13 * i + d.length }).toUTC().toISO(), i);
  }
  // Exactly on the boundaries of 2026-07-01 in Chicago: midnight belongs to the
  // day it starts, and a millisecond before it does not.
  const boundary = DateTime.fromISO('2026-07-01', { zone: TZ });
  add(boundary.toUTC().toISO(), 3);
  add(boundary.minus({ milliseconds: 1 }).toUTC().toISO(), 5);
  add(boundary.plus({ days: 1 }).toUTC().toISO(), 6);

  for (const [id, recruiterId, direction, duration, callTime] of rows) {
    await harness.query(
      `INSERT INTO ringcentral_calls (id, recruiter_id, direction, duration_seconds, call_time)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, recruiterId, direction, duration, callTime]
    );
  }
}

const json = (value) => JSON.stringify(value);

async function assertSameAsLegacy(harness, ringcentral, cfg, label) {
  for (const date of [null, '2026-06-30', '2026-07-01', '2026-07-02', '2026-07-04']) {
    const now = await ringcentral.getRecruiterStats(date, cfg);
    const old = await legacyStats(harness.query, date, cfg);
    assert.equal(json(now), json(old), `${label}: admin stats for ${date || 'today'}`);
  }
  for (const [start, end] of [['2026-07-01', '2026-07-03'], ['2026-06-28', '2026-07-05'], ['2026-07-02', '2026-07-02']]) {
    const now = await ringcentral.getRecruiterStatsRange(start, end, cfg);
    const old = await legacyStatsRange(harness.query, start, end, cfg);
    assert.equal(json(now), json(old), `${label}: admin stats for ${start}..${end}`);
  }
}

test('the SQL totals are byte-for-byte the old JavaScript totals, for every window and threshold', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { ringcentral } = harness.loadDataLayer(['ringcentral']);
  await seed(harness);

  const defaults = await ringcentral.getRcConfig();
  await assertSameAsLegacy(harness, ringcentral, defaults, 'stored defaults');

  // Configurations the settings form cannot produce but the arithmetic must
  // still agree on — every call valuable, every call "real" — and other zones.
  const edges = [
    { ...defaults, nonValuableMaxSeconds: 1, realConversationMinSeconds: 1, strongConversationMinSeconds: 1 },
    { ...defaults, nonValuableMaxSeconds: 0, realConversationMinSeconds: 0, strongConversationMinSeconds: 3600 },
    { ...defaults, nonValuableMaxSeconds: 3601, targetTalkSeconds: 60, targetOutbound: 0, targetRealConversations: 0 },
    { ...defaults, timezone: 'UTC' },
    { ...defaults, timezone: 'Asia/Tashkent' },
  ];
  for (const [i, cfg] of edges.entries()) await assertSameAsLegacy(harness, ringcentral, cfg, `edge config #${i}`);
});

test('the public payload is the one the old route sent — today, a day, a range — and carries no phone', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { ringcentral } = harness.loadDataLayer(['ringcentral']);
  await seed(harness);

  const compare = async (label) => {
    const cfg = await ringcentral.getRcConfig();
    const cases = [
      [{ mode: 'today', date: null }, () => legacyStats(harness.query, null, cfg)],
      [{ mode: 'single-day', date: '2026-07-01' }, () => legacyStats(harness.query, '2026-07-01', cfg)],
      [{ mode: 'range', start: '2026-06-30', end: '2026-07-03' }, () => legacyStatsRange(harness.query, '2026-06-30', '2026-07-03', cfg)],
    ];
    for (const [window, old] of cases) {
      const now = await ringcentral.getPublicRecruiterStats(window);
      assert.equal(json(now), json(legacyPublic(await old())), `${label}: ${window.mode}`);
      assert.ok(!/phone|4704804679/i.test(json(now)), 'never a phone number in the public payload');
    }
  };

  await compare('stored defaults');
  // A settings save must reach the public board at once, not after its cache.
  await ringcentral.updateRcSettings({
    nonValuableMaxSeconds: 60, realConversationMinSeconds: 120, strongConversationMinSeconds: 600,
    targetTalkMinutes: 90, targetOutbound: 40, targetRealConversations: 5, timezone: 'America/New_York',
  });
  await compare('after a settings save');
});

test('a call written through the data layer is on the public board at the next read', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { ringcentral } = harness.loadDataLayer(['ringcentral']);
  await seed(harness);

  const window = { mode: 'single-day', date: '2026-07-02' };
  const before = await ringcentral.getPublicRecruiterStats(window);
  const bob = (board) => board.recruiters.find((r) => r.id === 2);
  await ringcentral.upsertCall({
    id: 'late-1', recruiterId: 2, direction: 'Outbound', durationSeconds: 900,
    callTime: DateTime.fromISO('2026-07-02T10:00', { zone: TZ }).toUTC().toISO(),
  });
  const after = await ringcentral.getPublicRecruiterStats(window);
  assert.equal(bob(after).valuableTalkSeconds, bob(before).valuableTalkSeconds + 900);
  assert.equal(bob(after).outbound, bob(before).outbound + 1);

  // And an admin change to who is listed.
  await ringcentral.updateRecruiter(3, { active: false });
  const without = await ringcentral.getPublicRecruiterStats(window);
  assert.ok(!without.recruiters.some((r) => r.id === 3), 'a deactivated recruiter leaves the board at once');
});
