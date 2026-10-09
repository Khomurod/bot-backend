'use strict';

/**
 * What ONE RingCentral call-sync pass costs the database — and the leads
 * worker's 15-minute extension check beside it.
 *
 * October 2026, with the hosted database's monthly transfer allowance nearly
 * spent, a sync pass (every 10 minutes) sent: the whole settings row (twice —
 * the pass's own bookkeeping threw the cached copy away and the scheduler read
 * it again), every recruiter row with ~1.3 KB of encrypted tokens each, and one
 * upsert for EVERY call since midnight, changed or not — about 33,000
 * statements a day. Now a pass that finds nothing new sends two statements:
 * a one-row check that the recruiter roster is unchanged, and the sync stamp.
 *
 * The real sync and the real data layer run against a fake `pg` that records
 * every statement; only RingCentral itself is replaced.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { purgeDataLayer } = require('./helpers/purgeDataLayer');

const sent = [];
const state = {
  recruiters: [], fingerprint: 'roster-v1', failCallIds: new Set(),
  janeRecords: [], companyRecords: [], bobRecords: [], refreshTokensSeen: [],
};

async function respond(text, params = []) {
  if (/FROM ringcentral_settings/i.test(text)) return { rows: [{ ...SETTINGS_ROW }], rowCount: 1 };
  if (/md5\(/i.test(text) && /FROM recruiters/i.test(text)) {
    return { rows: [{ fingerprint: state.fingerprint }], rowCount: 1 };
  }
  if (/FROM recruiters/i.test(text)) return { rows: state.recruiters.map((r) => ({ ...r })), rowCount: state.recruiters.length };
  if (/INSERT INTO ringcentral_calls/i.test(text) && state.failCallIds.has(params[0])) {
    throw new Error('connection reset');
  }
  return { rows: [], rowCount: 1 };
}

const textOf = (q) => (typeof q === 'string' ? q : q?.text || '');
class FakeClient {
  async query(q, params) { sent.push({ text: textOf(q), params }); return respond(textOf(q), params); }
  release() {}
}
class FakePool {
  on() {}
  async query(q, params) { sent.push({ text: textOf(q), params }); return respond(textOf(q), params); }
  async connect() { return new FakeClient(); }
}
require.cache[require.resolve('pg')] = { exports: { Pool: FakePool } };

const realNow = Date.now;
let offsetMs = 0;
Date.now = () => realNow() + offsetMs;
const advance = (ms) => { offsetMs += ms; };

// eslint-disable-next-line global-require
const { encryptText } = require('../lib/security/facebookCrypto');

const SETTINGS_ROW = {
  enabled: true, api_base: 'https://rc.test',
  client_id_encrypted: encryptText('shared-client-id'),
  client_secret_encrypted: encryptText('shared-client-secret'),
  jwt_token_encrypted: encryptText('shared-jwt'),
  poll_minutes: 10, timezone: 'America/Chicago',
  non_valuable_max_seconds: 30, real_conversation_min_seconds: 60, strong_conversation_min_seconds: 180,
  target_talk_seconds: 9000, target_outbound: 150, target_real_conversations: 35,
  last_synced_at: null, last_sync_error: null, updated_at: null,
};

// Only RingCentral is replaced. Each fake hands back fresh copies, so a case
// can change a record between passes the way RingCentral finalizes a call.
const CALL_SVC = require.resolve('../services/ringCentralCallService');
const OAUTH_SVC = require.resolve('../services/ringCentralOAuthService');
const SYNC_SVC = require.resolve('../services/recruiterCallSyncService');
const INTERNAL = require.resolve('../server/routes/facebookConnect/internalRoutes');
require(CALL_SVC);
require(OAUTH_SVC);
const copies = (records) => records.map((r) => ({ ...r }));
require.cache[CALL_SVC].exports = {
  ...require.cache[CALL_SVC].exports,
  fetchAccountCallLog: async () => copies(state.companyRecords),
  fetchExtensionCallLog: async () => copies(state.companyRecords),
  fetchExtensionCallLogWithToken: async ({ accessToken }) => copies(
    accessToken === 'token-2' ? state.bobRecords : state.janeRecords,
  ),
};
let rc;
let syncNow;
require.cache[OAUTH_SVC].exports = {
  ...require.cache[OAUTH_SVC].exports,
  getRecruiterAccessToken: async (recruiter, cfg) => {
    const auth = rc.resolveRecruiterRcAuth(recruiter, cfg);
    if (auth.refreshToken) state.refreshTokensSeen.push(auth.refreshToken);
    return { accessToken: `token-${recruiter.id}`, apiBase: auth.apiBase, mode: auth.mode };
  },
};

const SYNC_COLUMNS = [
  'id', 'name', 'phone_number', 'phone_number_normalized', 'rc_extension_id',
  'jwt_token_encrypted', 'client_id_encrypted', 'client_secret_encrypted', 'refresh_token_encrypted',
];

const voice = (id, direction, duration, extra = {}) => ({
  id, type: 'Voice', direction, duration, result: 'Accepted', startTime: '2026-10-09T14:00:00.000Z', ...extra,
});

/** A process that has cached and written nothing: a fresh data layer and sync. */
function freshProcess() {
  purgeDataLayer([SYNC_SVC, INTERNAL]);
  rc = require('../database/ringcentral');
  ({ syncNow } = require(SYNC_SVC));
  state.fingerprint = 'roster-v1';
  state.failCallIds = new Set();
  state.refreshTokensSeen = [];
  state.recruiters = [
    // Jane signs in with her own JWT: her own extension log, direct attribution.
    {
      id: 1, name: 'Jane', phone_number_normalized: '4704804679', jwt_token_encrypted: encryptText('jane-jwt'),
      client_id_encrypted: null, client_secret_encrypted: null, refresh_token_encrypted: null,
    },
    // Bob has no credentials: covered by the shared company-log pass.
    {
      id: 2, name: 'Bob', phone_number_normalized: '2125551234', jwt_token_encrypted: null,
      client_id_encrypted: null, client_secret_encrypted: null, refresh_token_encrypted: null,
    },
  ];
  state.janeRecords = [
    voice('j1', 'Outbound', 29, { from: { phoneNumber: '+14704804679' }, to: { phoneNumber: '+15550000001' } }),
    voice('j2', 'Outbound', 40, { from: { phoneNumber: '+14704804679' }, to: { phoneNumber: '+15550000002' } }),
    voice('j3', 'Inbound', 0, { result: 'Missed', from: { phoneNumber: '+15550000003' }, to: { phoneNumber: '+14704804679' } }),
  ];
  state.companyRecords = [
    voice('b1', 'Inbound', 223, { from: { phoneNumber: '+16146804000' }, to: { phoneNumber: '+12125551234' } }),
    voice('x1', 'Outbound', 40, { from: { phoneNumber: '+19998887777' }, to: { phoneNumber: '+15551112222' } }),
  ];
  state.bobRecords = [];
  sent.length = 0;
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();
const WHOLE_ROW = /RETURNING \*|SELECT \*|SELECT [a-z_]+\.\*/i;
const texts = () => sent.map((q) => oneLine(q.text));
const listing = () => texts().map((s) => `  ${s.slice(0, 120)}`).join('\n');
const callWrites = () => sent.filter((q) => /INSERT INTO ringcentral_calls/i.test(q.text));
const writtenIds = () => callWrites().map((q) => q.params[0]);
const rosterReads = () => texts().filter((s) => /FROM recruiters/i.test(s) && !/md5\(/i.test(s));
/** The columns a `SELECT a, b, c FROM …` statement asks for. */
const selectList = (s) => s.replace(/^SELECT\s+/i, '').split(/\s+FROM\s+/i)[0].split(',').map((c) => c.trim());

test('A SYNC PASS reads exactly the recruiter columns it uses — and no whole rows anywhere', async () => {
  freshProcess();
  const result = await syncNow();
  assert.equal(result.synced, 5);
  assert.deepEqual(texts().filter((s) => WHOLE_ROW.test(s)).map((s) => s.slice(0, 120)), [],
    `whole-row reads in a sync pass:\n${listing()}`);
  assert.equal(rosterReads().length, 1, `one roster read:\n${listing()}`);
  assert.deepEqual(selectList(rosterReads()[0]).sort(), [...SYNC_COLUMNS].sort(),
    'the encrypted credentials the sync needs, and nothing else');
});

test('THE ROSTER CHECK hashes exactly the columns the pass reads, so no change to them can hide', async () => {
  freshProcess();
  await syncNow();
  const check = texts().find((s) => /md5\(/i.test(s) && /FROM recruiters/i.test(s));
  assert.ok(check, `the roster is checked before it is reused:\n${listing()}`);
  for (const column of SYNC_COLUMNS) {
    assert.match(check, new RegExp(`\\b${column}\\b`), `the check covers ${column}`);
  }
  assert.match(check, /WHERE active = TRUE/i, 'over the same rows the pass reads');
});

test('A STEADY-STATE PASS ten minutes later sends two statements: the roster check and the sync stamp', async () => {
  freshProcess();
  await syncNow();
  advance(10 * 60 * 1000);
  sent.length = 0;
  const result = await syncNow();
  assert.equal(result.synced, 5, 'every call is still accounted for');
  assert.deepEqual(result.errors, []);
  assert.equal(texts().length, 2, `a pass that found nothing new sent:\n${listing()}`);
  assert.match(texts()[0], /md5\(.*FROM recruiters/i);
  assert.match(texts()[1], /^UPDATE ringcentral_settings SET last_synced_at/i);
});

test("THE PASS'S OWN BOOKKEEPING keeps the cached settings — the scheduler's read after it is free", async () => {
  freshProcess();
  await syncNow();
  sent.length = 0;
  const cfg = await rc.getRcConfig();
  assert.equal(cfg.pollMinutes, 10);
  assert.deepEqual(texts(), [], `reading the poll interval after a pass reached the database:\n${listing()}`);
  assert.ok(cfg.lastSyncedAt instanceof Date, 'the cached copy still reports the pass it just recorded');
});

test('A CHANGED CALL is written on the very next pass, and only that call', async () => {
  freshProcess();
  await syncNow();
  state.janeRecords[1] = { ...state.janeRecords[1], duration: 95 };
  state.companyRecords.push(voice('b2', 'Outbound', 31, { from: { phoneNumber: '+12125551234' }, to: { phoneNumber: '+15550000009' } }));
  sent.length = 0;
  await syncNow();
  assert.deepEqual(writtenIds().sort(), ['b2', 'j2'], `only the finalized call and the new one:\n${listing()}`);
  assert.ok(callWrites().find((q) => q.params[0] === 'j2').params.includes(95), 'with its new duration');
});

test('A WRITE THAT FAILED is not remembered — the next pass writes it, and nothing it already stored', async () => {
  freshProcess();
  state.failCallIds = new Set(['j3']);
  const first = await syncNow();
  assert.equal(first.errors.length, 1, 'the failure is reported, as before');
  state.failCallIds = new Set();
  sent.length = 0;
  await syncNow();
  assert.deepEqual(writtenIds(), ['j3'], `the failed call, and only it, is written again:\n${listing()}`);
});

test('AN UNCHANGED CALL is re-written after six hours — the safety net for a write this process did not see', async () => {
  freshProcess();
  await syncNow();
  advance(6 * 60 * 60 * 1000 + 1);
  sent.length = 0;
  await syncNow();
  assert.deepEqual(writtenIds().sort(), ['b1', 'j1', 'j2', 'j3', 'x1']);
});

test('A ROSTER CHANGE is read on the next pass, and an unchanged roster is not read again', async () => {
  freshProcess();
  await syncNow();
  // Bob is given his own JWT: the database's roster hash changes with it.
  state.recruiters[1] = { ...state.recruiters[1], jwt_token_encrypted: encryptText('bob-jwt') };
  state.fingerprint = 'roster-v2';
  state.bobRecords = [voice('o1', 'Outbound', 61, { from: { phoneNumber: '+12125551234' }, to: { phoneNumber: '+15550000010' } })];
  sent.length = 0;
  const second = await syncNow();
  assert.equal(rosterReads().length, 1, `the changed roster was re-read:\n${listing()}`);
  assert.ok(second.perRecruiter.some((p) => p.id === 2 && p.synced === 1), 'Bob now syncs his own extension');
  sent.length = 0;
  await syncNow();
  assert.equal(rosterReads().length, 0, `an unchanged roster was read again:\n${listing()}`);
});

test('A ROTATED REFRESH TOKEN is the one the next pass uses — the per-recruiter credential invariant', async () => {
  freshProcess();
  state.recruiters[0] = { ...state.recruiters[0], refresh_token_encrypted: encryptText('refresh-1') };
  await syncNow();
  // Another caller rotated it: the stored token changed, so the hash did.
  state.recruiters[0] = { ...state.recruiters[0], refresh_token_encrypted: encryptText('refresh-2') };
  state.fingerprint = 'roster-rotated';
  await syncNow();
  assert.deepEqual(state.refreshTokensSeen, ['refresh-1', 'refresh-2']);
});

test("THE LEADS WORKER'S EXTENSION CHECK reads id, name and extension — nothing else", async () => {
  freshProcess();
  const stubs = {
    '../services/facebookWebhookService': { enqueueVerifiedFacebookPayload: async () => ({}), retryFacebookWebhookEvent: async () => null },
    '../services/facebookConnectService': { createConnectSession: async () => ({}) },
    '../services/leadsTelegramClient': { getLeadsTelegram: () => null, sendLeadsMessage: async () => ({}) },
    '../services/facebookLeadSmsMirrorService': { handleTelegramSmsReply: async () => ({}), registerSmsMirror: async () => ({}) },
  };
  for (const [specifier, exports] of Object.entries(stubs)) require.cache[require.resolve(specifier)] = { exports };
  const { createFacebookInternalRoutes } = require(INTERNAL);
  state.recruiters = [
    { id: 7, name: 'Jane', rc_extension_id: '101' },
    { id: 9, name: null, rc_extension_id: null },
  ];
  const app = express();
  app.use(createFacebookInternalRoutes({ db: {}, internalSharedSecretGuard: (req, res, next) => next() }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/internal/ringcentral/sms-extensions`);
    assert.deepEqual(await res.json(), { extensions: ['101'] });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(texts().length, 1, listing());
  assert.doesNotMatch(texts()[0], WHOLE_ROW, 'not the whole row, with every encrypted token');
  assert.deepEqual(selectList(texts()[0]), ['id', 'name', 'rc_extension_id']);
  assert.match(texts()[0], /refresh_token_encrypted IS NOT NULL OR jwt_token_encrypted IS NOT NULL/,
    'the same recruiters as before: active, with credentials of their own');
});
