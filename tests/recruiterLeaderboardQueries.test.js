'use strict';

/**
 * What ONE poll of the public recruiter leaderboard costs the database.
 *
 * October 2026: the hosted database's monthly transfer allowance was nearly
 * spent, and `/recruiters` — open all day on an office screen, polling every
 * 60 seconds in the "today" view — cost about 14 MB a day per open screen. Each
 * poll read the whole RingCentral settings row (its 15-second cache always
 * missed at a 60-second poll) and then ONE ROW PER CALL made today, so that
 * JavaScript could add up `direction` and `duration_seconds`.
 *
 * Now the totals are computed in SQL (one row per recruiter), and the answer is
 * kept in this process until something it shows can have changed: a call the
 * sync wrote, an admin change to a recruiter, a settings save — or five
 * minutes, the safety net for a write this process did not see.
 *
 * The real data layer and the real route run here against a fake `pg` that
 * records every statement.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { DateTime } = require('luxon');

const sent = [];
const state = { board: null, aggregateGate: null, recruiterName: 'Jane' };

const SETTINGS_ROW = {
  enabled: true, api_base: 'https://platform.ringcentral.com',
  client_id_encrypted: null, client_secret_encrypted: null, jwt_token_encrypted: null,
  poll_minutes: 10, timezone: 'America/Chicago',
  non_valuable_max_seconds: 30, real_conversation_min_seconds: 60, strong_conversation_min_seconds: 180,
  target_talk_seconds: 9000, target_outbound: 150, target_real_conversations: 35,
  last_synced_at: null, last_sync_error: null, updated_at: null,
};

/** One aggregate row per active recruiter — what the leaderboard SQL returns. */
function boardRow(overrides = {}) {
  return {
    id: 1, name: state.recruiterName, phone_number: '+14704804679',
    total_calls: 3, outbound: 2, inbound: 1, real_conversations: 1, strong_conversations: 0,
    non_valuable_calls: 1, non_valuable_seconds: 29, total_talk_seconds: 119, valuable_talk_seconds: 90,
    ...overrides,
  };
}

async function respond(text) {
  if (/FROM ringcentral_settings/i.test(text)) return { rows: [{ ...SETTINGS_ROW }], rowCount: 1 };
  if (/ringcentral_calls/i.test(text) && /FROM recruiters r/i.test(text)) {
    if (state.aggregateGate) await state.aggregateGate;
    return { rows: [boardRow(state.board || {})], rowCount: 1 };
  }
  if (/UPDATE recruiters|INSERT INTO recruiters/i.test(text)) {
    return { rows: [{ id: 1, name: state.recruiterName, phone_number: '+14704804679', active: true }], rowCount: 1 };
  }
  return { rows: [], rowCount: 1 };
}

const textOf = (q) => (typeof q === 'string' ? q : q?.text || '');
class FakeClient {
  async query(q) { sent.push(textOf(q)); return respond(textOf(q)); }
  release() {}
}
class FakePool {
  on() {}
  async query(q) { sent.push(textOf(q)); return respond(textOf(q)); }
  async connect() { return new FakeClient(); }
}
require.cache[require.resolve('pg')] = { exports: { Pool: FakePool } };

// A clock that only moves forward, for the TTL cases. luxon reads Date.now too.
const realNow = Date.now;
let offsetMs = 0;
Date.now = () => realNow() + offsetMs;
const advance = (ms) => { offsetMs += ms; };

const { purgeDataLayer } = require('./helpers/purgeDataLayer');

const ROUTE = require.resolve('../server/routes/recruiterRoutes');
const SYNC_SVC = require.resolve('../services/recruiterCallSyncService');
let rc;
let createRecruiterRouter;

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const WHOLE_ROW = /RETURNING \*|SELECT \*|SELECT [a-z_]+\.\*/i;
const statements = () => sent.map(oneLine);
const listing = () => statements().map((s) => `  ${s.slice(0, 120)}`).join('\n');
const callReads = () => statements().filter((s) => /ringcentral_calls/i.test(s));
const settingsReads = () => statements().filter((s) => /FROM ringcentral_settings/i.test(s));

const TODAY = { mode: 'today', date: null };

async function getJson(app, pathname) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`);
    return { status: res.status, json: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function sendJson(app, method, pathname, body) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/recruiters', createRecruiterRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'admin' }; next(); },
  }));
  return app;
}

/** Start from a process that has cached nothing: a fresh data layer and route. */
function freshProcess() {
  purgeDataLayer([ROUTE, SYNC_SVC]);
  rc = require('../database/ringcentral');
  ({ createRecruiterRouter } = require(ROUTE));
  state.board = null;
  state.aggregateGate = null;
  state.recruiterName = 'Jane';
  sent.length = 0;
}

test('A PUBLIC POLL reads one aggregate row per recruiter — never one row per call, never a whole row', async () => {
  freshProcess();
  const app = makeApp();
  const { status, json } = await getJson(app, '/api/recruiters/public-stats');
  assert.equal(status, 200);
  assert.equal(json.dateMode, 'today');

  assert.deepEqual(statements().filter((s) => WHOLE_ROW.test(s)).map((s) => s.slice(0, 120)), [],
    `whole-row reads on the leaderboard path:\n${listing()}`);
  assert.equal(callReads().length, 1, `exactly one statement reads the calls:\n${listing()}`);
  const [aggregate] = callReads();
  assert.match(aggregate, /count\(\*\)/i, 'the totals are counted in SQL');
  assert.match(aggregate, /sum\(/i, 'and summed in SQL');
  assert.doesNotMatch(aggregate, /call_id|c\.duration_seconds\s*,|c\.direction\s*,/i, 'no per-call columns come back');
  assert.equal(statements().length, 2, `a cold poll is the settings read plus the aggregate:\n${listing()}`);
});

test('A REPEATED POLL a minute later costs nothing — the answer is kept until something it shows changes', async () => {
  freshProcess();
  const app = makeApp();
  await getJson(app, '/api/recruiters/public-stats');
  sent.length = 0;
  const again = await getJson(app, '/api/recruiters/public-stats');
  assert.equal(again.status, 200);
  assert.deepEqual(statements(), [], `a repeated poll reached the database:\n${listing()}`);
});

test('ONE MINUTE APART, ALL MORNING: the settings row is not re-read and the board is not recomputed', async () => {
  freshProcess();
  const app = makeApp();
  await getJson(app, '/api/recruiters/public-stats');
  sent.length = 0;
  for (let minute = 0; minute < 4; minute += 1) {
    advance(60 * 1000);
    const { status } = await getJson(app, '/api/recruiters/public-stats');
    assert.equal(status, 200);
  }
  assert.deepEqual(statements(), [], `polls inside the safety window reached the database:\n${listing()}`);
});

test('A CALL THE SYNC WROTE is on the board at the very next poll — one aggregate, settings still cached', async () => {
  freshProcess();
  await rc.getPublicRecruiterStats(TODAY);
  await rc.upsertCall({
    id: 'rc-new-1', recruiterId: 1, direction: 'Outbound', durationSeconds: 300, callTime: new Date().toISOString(),
  });
  state.board = { total_calls: 4, outbound: 3, valuable_talk_seconds: 390, total_talk_seconds: 419 };
  sent.length = 0;
  const board = await rc.getPublicRecruiterStats(TODAY);
  assert.equal(board.recruiters[0].valuableTalkSeconds, 390, 'the new call is counted');
  assert.equal(callReads().length, 1, `the board was recomputed:\n${listing()}`);
  assert.equal(settingsReads().length, 0, `the settings were not read again for it:\n${listing()}`);
});

test('AN ADMIN CHANGE TO A RECRUITER is on the board at the next poll', async () => {
  freshProcess();
  const app = makeApp();
  await getJson(app, '/api/recruiters/public-stats');
  const saved = await sendJson(app, 'PUT', '/api/recruiters/1', { name: 'Janet' });
  assert.equal(saved.status, 200);
  state.recruiterName = 'Janet';
  sent.length = 0;
  const { json } = await getJson(app, '/api/recruiters/public-stats');
  assert.equal(json.recruiters[0].name, 'Janet');
  assert.equal(callReads().length, 1, `the rename recomputed the board:\n${listing()}`);
});

test('A SETTINGS SAVE is on the board at the next poll — new targets, new thresholds', async () => {
  freshProcess();
  const before = await rc.getPublicRecruiterStats(TODAY);
  assert.equal(before.targets.outbound, 150);
  const original = SETTINGS_ROW.target_outbound;
  SETTINGS_ROW.target_outbound = 200;
  try {
    await rc.updateRcSettings({ targetOutbound: 200 });
    sent.length = 0;
    const after = await rc.getPublicRecruiterStats(TODAY);
    assert.equal(after.targets.outbound, 200);
    assert.equal(callReads().length, 1, `the save recomputed the board:\n${listing()}`);
  } finally {
    SETTINGS_ROW.target_outbound = original;
  }
});

test('THE SAFETY WINDOW: an answer older than five minutes is recomputed even when nothing here changed', async () => {
  freshProcess();
  await rc.getPublicRecruiterStats(TODAY);
  advance(4 * 60 * 1000);
  sent.length = 0;
  await rc.getPublicRecruiterStats(TODAY);
  assert.equal(callReads().length, 0, 'still inside the window');
  advance(60 * 1000 + 1);
  await rc.getPublicRecruiterStats(TODAY);
  assert.equal(callReads().length, 1, `past five minutes the board is recomputed:\n${listing()}`);
});

test('TODAY ROLLS OVER at midnight in the configured time zone, inside the safety window too', async () => {
  freshProcess();
  // Two minutes before the next Chicago midnight — always a step FORWARD.
  const twoBeforeMidnight = DateTime.fromMillis(Date.now() + 5 * 60 * 1000)
    .setZone('America/Chicago').plus({ days: 1 }).startOf('day').minus({ minutes: 2 });
  advance(twoBeforeMidnight.toMillis() - Date.now());
  const first = await rc.getPublicRecruiterStats(TODAY);
  advance(3 * 60 * 1000); // past midnight, still well inside the five minutes
  sent.length = 0;
  const next = await rc.getPublicRecruiterStats(TODAY);
  assert.notEqual(next.date, first.date, 'a new day is a new board');
  assert.equal(callReads().length, 1, `yesterday's answer was served for today:\n${listing()}`);
});

test('A RECOMPUTE THAT RACED A WRITE is answered but not kept, so the write is never hidden', async () => {
  freshProcess();
  let release;
  state.aggregateGate = new Promise((resolve) => { release = resolve; });
  const inFlight = rc.getPublicRecruiterStats(TODAY);
  await new Promise((resolve) => setImmediate(resolve));
  await rc.upsertCall({
    id: 'rc-race-1', recruiterId: 1, direction: 'Inbound', durationSeconds: 45, callTime: new Date().toISOString(),
  });
  release();
  await inFlight;
  state.aggregateGate = null;
  sent.length = 0;
  await rc.getPublicRecruiterStats(TODAY);
  assert.equal(callReads().length, 1, `the answer computed before the write was cached:\n${listing()}`);
});

test('SCREENS POLLING AT THE SAME MOMENT share one recompute', async () => {
  freshProcess();
  await rc.getRcConfig();
  sent.length = 0;
  await Promise.all([1, 2, 3].map(() => rc.getPublicRecruiterStats(TODAY)));
  assert.equal(callReads().length, 1, `three simultaneous polls ran ${callReads().length} aggregates`);
});

test('THE PUBLIC ANSWER never carries a phone number, even though the aggregate row has one', async () => {
  freshProcess();
  const board = await rc.getPublicRecruiterStats({ mode: 'single-day', date: '2026-07-01' });
  const text = JSON.stringify(board);
  assert.ok(!/phone/i.test(text), 'no phone field');
  assert.ok(!text.includes('4704804679'), 'no phone digits');
  assert.deepEqual(Object.keys(board), [
    'dateMode', 'date', 'startDate', 'endDate', 'rangeDays', 'timezone', 'targets', 'thresholds', 'recruiters',
  ]);
});

test('THE CACHE IS BOUNDED — the endpoint is public, so any number of windows can be asked for', async () => {
  freshProcess();
  await rc.getRcConfig();
  const day = (i) => ({ mode: 'single-day', date: DateTime.fromISO('2026-01-01').plus({ days: i }).toISODate() });
  for (let i = 0; i < 40; i += 1) await rc.getPublicRecruiterStats(day(i));
  sent.length = 0;
  await rc.getPublicRecruiterStats(day(39));
  assert.equal(callReads().length, 0, 'the most recent window is still kept');
  await rc.getPublicRecruiterStats(day(0));
  assert.equal(callReads().length, 1, 'the oldest was let go rather than kept forever');
});
