const test = require('node:test');
const assert = require('node:assert/strict');

// Mock the DB layer and the RingCentral client BEFORE the sync service loads,
// so syncNow() runs against controlled fakes.
const rcDbPath = require.resolve('../database/ringcentral');
const realRcDb = require(rcDbPath);

const state = {
  cfg: null,
  recruiters: [],
  upserts: [],
  syncMark: null,
  accountLogBehavior: null,
  extensionLogBehavior: null,
  accountCalls: 0,
  extensionCalls: 0,
};

require.cache[rcDbPath].exports = {
  ...realRcDb,
  getRcConfig: async () => state.cfg,
  listRecruiters: async () => state.recruiters,
  upsertCall: async (row) => { state.upserts.push(row); },
  markSyncResult: async (r) => { state.syncMark = r; },
};

const rcSvcPath = require.resolve('../services/ringCentralCallService');
require(rcSvcPath);
require.cache[rcSvcPath].exports = {
  ...require.cache[rcSvcPath].exports,
  fetchAccountCallLog: async () => { state.accountCalls += 1; return state.accountLogBehavior(); },
  fetchExtensionCallLog: async () => { state.extensionCalls += 1; return state.extensionLogBehavior(); },
};

const { syncNow } = require('../services/recruiterCallSyncService');

function resetState() {
  state.cfg = {
    enabled: true, apiBase: 'https://platform.ringcentral.com',
    clientId: 'CID', clientSecret: 'SEC', jwtToken: 'JWT',
    pollMinutes: 10, timezone: 'America/Chicago',
  };
  state.recruiters = [
    { id: 4, name: 'Jaime', phone_number: '(470) 480-4679', phone_number_normalized: '4704804679', active: true, jwt_token_encrypted: null },
  ];
  state.upserts = [];
  state.syncMark = null;
  state.accountCalls = 0;
  state.extensionCalls = 0;
}

const SAMPLE_RECORDS = [
  { id: 'a1', direction: 'Inbound', duration: 223, type: 'Voice', result: 'Accepted',
    from: { phoneNumber: '+16146804000' }, to: { phoneNumber: '+14704804679' }, startTime: '2026-07-02T14:46:41Z' },
  { id: 'a2', direction: 'Outbound', duration: 40, type: 'Voice', result: 'Accepted',
    from: { phoneNumber: '+14709999999' }, to: { phoneNumber: '+15551112222' }, startTime: '2026-07-02T14:50:00Z' },
];

test('shared pass falls back to the extension log when the company log is denied (403)', async () => {
  resetState();
  state.accountLogBehavior = () => { const e = new Error('RingCentral call-log 403: InsufficientPermissions'); e.status = 403; throw e; };
  state.extensionLogBehavior = () => SAMPLE_RECORDS;

  const result = await syncNow();
  assert.equal(state.accountCalls, 1, 'company log tried first');
  assert.equal(state.extensionCalls, 1, 'extension log used as fallback');
  assert.equal(result.synced, 2);
  assert.equal(result.attributed, 1, 'only the matching number attributes');
  assert.deepEqual(result.errors, []);
  assert.equal(state.syncMark.error, null, 'sync marked clean');
  assert.equal(state.upserts.find((u) => u.id === 'a1').recruiterId, 4);
  assert.equal(state.upserts.find((u) => u.id === 'a2').recruiterId, null);
});

test('non-403 company-log failures are reported, not silently swallowed', async () => {
  resetState();
  state.accountLogBehavior = () => { const e = new Error('RingCentral call-log 500: boom'); e.status = 500; throw e; };
  state.extensionLogBehavior = () => { throw new Error('must not be called'); };

  const result = await syncNow();
  assert.equal(state.extensionCalls, 0, 'no fallback on non-403');
  assert.equal(result.synced, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /500: boom/);
  assert.match(state.syncMark.error, /500: boom/);
});

test('company log used directly when the shared JWT is an admin', async () => {
  resetState();
  state.accountLogBehavior = () => SAMPLE_RECORDS;
  state.extensionLogBehavior = () => { throw new Error('must not be called'); };

  const result = await syncNow();
  assert.equal(state.extensionCalls, 0);
  assert.equal(result.synced, 2);
  assert.equal(result.attributed, 1);
});
