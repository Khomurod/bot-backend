/**
 * Route tests for GET /api/recruiters/public-stats — the unauthenticated
 * leaderboard feed. Covers today / single historical day / date range modes,
 * per-day target scaling, date validation, the 31-day range cap, and that the
 * public payload never leaks phone numbers or credentials.
 */
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-secret';
process.env.BOT_TOKEN ||= '123:test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= '123:test-bot-token';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-encryption-key';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { DateTime } = require('luxon');

const TZ = 'America/Chicago';

const SETTINGS_ROW = {
  id: 1,
  enabled: true,
  api_base: 'https://platform.ringcentral.com',
  client_id_encrypted: null,
  client_secret_encrypted: null,
  jwt_token_encrypted: null,
  poll_minutes: 10,
  timezone: TZ,
  non_valuable_max_seconds: 30,
  real_conversation_min_seconds: 60,
  strong_conversation_min_seconds: 180,
  target_talk_seconds: 9000,
  target_outbound: 150,
  target_real_conversations: 35,
  last_synced_at: null,
  last_sync_error: null,
  updated_at: null,
};

const RECRUITERS = [
  { id: 1, name: 'Jane', phone_number: '+1 (470) 480-4679' },
  { id: 2, name: 'Bob', phone_number: '+1 (212) 555-1234' },
];

function at(dateIso, hour) {
  return DateTime.fromISO(dateIso, { zone: TZ }).set({ hour }).toUTC().toISO();
}

// Seeded call log: 2026-07-01 carries the canonical 29s/30s/60s trio for Jane.
const CALLS = [
  { id: 'c1', recruiter_id: 1, direction: 'Outbound', duration_seconds: 29, call_time: at('2026-07-01', 9) },
  { id: 'c2', recruiter_id: 1, direction: 'Outbound', duration_seconds: 30, call_time: at('2026-07-01', 10) },
  { id: 'c3', recruiter_id: 1, direction: 'Inbound', duration_seconds: 60, call_time: at('2026-07-01', 11) },
  { id: 'c4', recruiter_id: 1, direction: 'Outbound', duration_seconds: 300, call_time: at('2026-07-02', 9) },
  { id: 'c5', recruiter_id: 2, direction: 'Outbound', duration_seconds: 200, call_time: at('2026-07-03', 9) },
];

/** Emulates the LEFT JOIN + window filter the rollup SQL performs. */
function makeDbMock({ recruiters = RECRUITERS, calls = CALLS, settings = SETTINGS_ROW } = {}) {
  return {
    async query(sql, params = []) {
      if (/FROM ringcentral_settings/i.test(sql)) return { rows: [settings] };
      if (/FROM recruiters r/i.test(sql)) {
        const start = new Date(params[0]).getTime();
        const end = new Date(params[1]).getTime();
        const rows = [];
        for (const r of recruiters) {
          const matched = calls.filter((c) => {
            const t = new Date(c.call_time).getTime();
            return c.recruiter_id === r.id && t >= start && t < end;
          });
          if (!matched.length) {
            rows.push({ id: r.id, name: r.name, phone_number: r.phone_number, call_id: null, direction: null, duration_seconds: null });
          } else {
            for (const c of matched) {
              rows.push({ id: r.id, name: r.name, phone_number: r.phone_number, call_id: c.id, direction: c.direction, duration_seconds: c.duration_seconds });
            }
          }
        }
        return { rows };
      }
      throw new Error(`Unexpected query in test: ${sql.slice(0, 80)}`);
    },
  };
}

function loadApp(dbMock) {
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const rcPath = path.resolve(__dirname, '../database/ringcentral.js');
  const routePath = path.resolve(__dirname, '../server/routes/recruiterRoutes.js');
  const syncPath = path.resolve(__dirname, '../services/recruiterCallSyncService.js');
  const callSvcPath = path.resolve(__dirname, '../services/ringCentralCallService.js');
  for (const p of [dbPath, rcPath, routePath, syncPath, callSvcPath]) delete require.cache[p];
  require.cache[dbPath] = { exports: dbMock };

  const { createRecruiterRouter } = require(routePath);
  const app = express();
  app.use(express.json());
  app.use('/api/recruiters', createRecruiterRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'admin' }; next(); },
  }));
  return app;
}

async function get(app, pathname) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);
    return { status: res.status, json: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('public today endpoint works and reports dateMode "today"', async () => {
  const app = loadApp(makeDbMock());
  const { status, json } = await get(app, '/api/recruiters/public-stats');
  assert.equal(status, 200);
  assert.equal(json.dateMode, 'today');
  assert.equal(json.rangeDays, 1);
  assert.equal(json.timezone, TZ);
  assert.equal(json.date, DateTime.now().setZone(TZ).toISODate());
  assert.equal(json.targets.talkSeconds, 9000);
  assert.equal(json.targets.talkLabel, '2h 30m');
  assert.equal(json.targets.outbound, 150);
  assert.equal(json.recruiters.length, 2);
  for (const r of json.recruiters) {
    for (const key of ['valuableTalkSeconds', 'totalTalkSeconds', 'nonValuableCalls', 'nonValuableSeconds',
      'talkPct', 'talkMet', 'talkRemainingSeconds', 'outboundPct', 'outboundMet', 'mainScore', 'activityScore']) {
      assert.ok(key in r, `recruiter payload missing ${key}`);
    }
  }
});

test('public single-day endpoint returns that day only — and excludes sub-30s calls', async () => {
  const app = loadApp(makeDbMock());
  const { status, json } = await get(app, '/api/recruiters/public-stats?date=2026-07-01');
  assert.equal(status, 200);
  assert.equal(json.dateMode, 'single-day');
  assert.equal(json.date, '2026-07-01');
  assert.equal(json.startDate, '2026-07-01');
  assert.equal(json.endDate, '2026-07-01');

  const jane = json.recruiters.find((r) => r.name === 'Jane');
  // 29s + 30s + 60s on that day → only 30 + 60 count toward the main KPI.
  assert.equal(jane.valuableTalkSeconds, 90);
  assert.equal(jane.totalTalkSeconds, 119);
  assert.equal(jane.nonValuableCalls, 1);
  assert.equal(jane.nonValuableSeconds, 29);
  assert.equal(jane.totalCalls, 3);
  assert.equal(jane.outbound, 2);
  assert.equal(jane.inbound, 1);
  // Jane's 2026-07-02 call must NOT bleed into the 07-01 view.
  const bob = json.recruiters.find((r) => r.name === 'Bob');
  assert.equal(bob.totalCalls, 0);
  assert.equal(bob.valuableTalkSeconds, 0);
});

test('public range endpoint aggregates inclusively and scales targets by days', async () => {
  const app = loadApp(makeDbMock());
  const { status, json } = await get(app, '/api/recruiters/public-stats?start=2026-07-01&end=2026-07-03');
  assert.equal(status, 200);
  assert.equal(json.dateMode, 'range');
  assert.equal(json.startDate, '2026-07-01');
  assert.equal(json.endDate, '2026-07-03');
  assert.equal(json.rangeDays, 3);
  // 3-day range → 3 × 9000s talk target, 3 × 150 outbound target.
  assert.equal(json.targets.talkSeconds, 27000);
  assert.equal(json.targets.outbound, 450);

  const jane = json.recruiters.find((r) => r.name === 'Jane');
  assert.equal(jane.valuableTalkSeconds, 90 + 300); // 07-01 valuable + 07-02 call
  const bob = json.recruiters.find((r) => r.name === 'Bob');
  assert.equal(bob.valuableTalkSeconds, 200); // 07-03 call is inside the inclusive end
});

test('public payload hides phone numbers, credentials, and secrets', async () => {
  const app = loadApp(makeDbMock());
  const { json } = await get(app, '/api/recruiters/public-stats?date=2026-07-01');
  const body = JSON.stringify(json);
  assert.ok(!body.includes('4704804679'), 'raw phone digits leaked');
  assert.ok(!body.includes('470) 480'), 'formatted phone leaked');
  assert.ok(!/phone/i.test(body), 'phone field leaked');
  assert.ok(!/jwt|secret|password|encrypted/i.test(body), 'credential-ish field leaked');
  for (const r of json.recruiters) assert.ok(!('phoneNumber' in r));
});

test('invalid dates return 400', async () => {
  const app = loadApp(makeDbMock());
  for (const qs of [
    '?date=garbage',
    '?date=2026-13-05',
    '?date=2026-02-30',
    '?start=2026-07-01',                       // start without end
    '?start=bad&end=2026-07-03',
    '?start=2026-07-05&end=2026-07-01',        // end before start
  ]) {
    const { status, json } = await get(app, `/api/recruiters/public-stats${qs}`);
    assert.equal(status, 400, `expected 400 for ${qs}`);
    assert.ok(json.error);
  }
});

test('ranges longer than 31 days return 400', async () => {
  const app = loadApp(makeDbMock());
  const over = await get(app, '/api/recruiters/public-stats?start=2026-06-01&end=2026-07-03');
  assert.equal(over.status, 400);
  // Exactly 31 days is allowed.
  const max = await get(app, '/api/recruiters/public-stats?start=2026-06-03&end=2026-07-03');
  assert.equal(max.status, 200);
  assert.equal(max.json.rangeDays, 31);
});

test('a one-day start/end range behaves like a single day', async () => {
  const app = loadApp(makeDbMock());
  const { status, json } = await get(app, '/api/recruiters/public-stats?start=2026-07-01&end=2026-07-01');
  assert.equal(status, 200);
  assert.equal(json.dateMode, 'single-day');
  assert.equal(json.rangeDays, 1);
  assert.equal(json.targets.talkSeconds, 9000);
});

test('a changed nonValuableMaxSeconds setting drives the main KPI cutoff', async () => {
  const app = loadApp(makeDbMock({
    settings: { ...SETTINGS_ROW, non_valuable_max_seconds: 60 },
  }));
  const { json } = await get(app, '/api/recruiters/public-stats?date=2026-07-01');
  const jane = json.recruiters.find((r) => r.name === 'Jane');
  // With a 60s minimum, the 29s AND 30s calls no longer count.
  assert.equal(jane.valuableTalkSeconds, 60);
  assert.equal(jane.nonValuableCalls, 2);
  assert.equal(json.thresholds.nonValuableMaxSeconds, 60);
});

test('admin /stats endpoint supports the same date/range parsing', async () => {
  const app = loadApp(makeDbMock());
  const day = await get(app, '/api/recruiters/stats?date=2026-07-01');
  assert.equal(day.status, 200);
  assert.equal(day.json.dateMode, 'single-day');
  // Admin payload keeps phone numbers (auth-protected).
  assert.ok(day.json.recruiters.every((r) => 'phoneNumber' in r));
  const bad = await get(app, '/api/recruiters/stats?date=nope');
  assert.equal(bad.status, 400);
});
