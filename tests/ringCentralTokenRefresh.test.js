/**
 * The daily job that stops recruiter logins expiring from disuse.
 *
 * A RingCentral refresh token dies after 7 days. A recruiter can easily go a
 * week without being assigned a lead, so nothing in the lead flow guarantees
 * their token gets used inside that window — without this job their login
 * expires quietly and their leads start going out from the shared number on a
 * Monday nobody was watching.
 *
 * What is asserted: every OAuth recruiter is refreshed, JWT rows are left
 * alone, one recruiter's failure never stops the rest, and an expired grant is
 * reported as "needs to sign in again" rather than retried forever.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

const RC_PATH = require.resolve('../database/ringcentral');
const OAUTH_PATH = require.resolve('../services/ringCentralOAuthService');
const JOB_PATH = require.resolve('../services/ringCentralTokenRefreshService');

const CFG = { apiBase: 'https://rc.test', clientId: 'cid', clientSecret: 'sec' };

function loadJob({ recruiters = [], refresh = async () => ({ accessToken: 'a', expiresIn: 3600 }), listError = null, cfgError = null } = {}) {
  const refreshed = [];
  require.cache[RC_PATH] = {
    exports: {
      listRecruitersWithOwnCredentials: async () => {
        if (listError) throw listError;
        return recruiters;
      },
      getRcConfig: async () => {
        if (cfgError) throw cfgError;
        return CFG;
      },
      resolveRecruiterRcAuth: (row) => ({
        ...CFG,
        refreshToken: row.refresh_token_encrypted ? 'refresh-1' : '',
        jwtToken: row.jwt_token_encrypted ? 'jwt' : '',
        mode: row.refresh_token_encrypted ? 'oauth' : (row.jwt_token_encrypted ? 'jwt' : 'none'),
      }),
    },
  };
  require.cache[OAUTH_PATH] = {
    exports: {
      refreshRecruiterTokens: async (recruiter, auth) => {
        refreshed.push(recruiter.id);
        return refresh(recruiter, auth);
      },
    },
  };
  delete require.cache[JOB_PATH];
  const job = require(JOB_PATH);
  const restore = () => {
    for (const path of [RC_PATH, OAUTH_PATH, JOB_PATH]) delete require.cache[path];
  };
  return { job, refreshed, restore };
}

const oauthRow = (id, name) => ({ id, name, refresh_token_encrypted: 'enc' });
const jwtRow = (id, name) => ({ id, name, jwt_token_encrypted: 'enc' });

test('every OAuth login is refreshed; JWT rows are left alone', async () => {
  const { job, refreshed, restore } = loadJob({
    recruiters: [oauthRow(1, 'Jane'), jwtRow(2, 'Bob'), oauthRow(3, 'Ada')],
  });
  try {
    const summary = await job.refreshAllRecruiterTokens({ delayMs: 0 });
    assert.deepEqual(refreshed, [1, 3], 'a JWT does not expire, so there is nothing to keep alive');
    assert.deepEqual(
      { checked: summary.checked, refreshed: summary.refreshed, failed: summary.failed },
      { checked: 2, refreshed: 2, failed: 0 },
    );
    assert.deepEqual(summary.needsLogin, []);
    assert.deepEqual(summary.errors, []);
  } finally { restore(); }
});

test('one recruiter failing does not stop the others', async () => {
  const { job, refreshed, restore } = loadJob({
    recruiters: [oauthRow(1, 'Jane'), oauthRow(2, 'Bob'), oauthRow(3, 'Ada')],
    refresh: async (recruiter) => {
      if (recruiter.id === 2) throw new Error('503 Service unavailable');
      return { accessToken: 'a', expiresIn: 3600 };
    },
  });
  try {
    const summary = await job.refreshAllRecruiterTokens({ delayMs: 0 });
    assert.deepEqual(refreshed, [1, 2, 3], 'the loop continues past a failure');
    assert.equal(summary.refreshed, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.errors.length, 1);
    assert.match(summary.errors[0], /^Bob: .*Service unavailable/);
  } finally { restore(); }
});

test('an expired grant is listed as needing a new sign-in, not as a generic error', async () => {
  const expired = Object.assign(new Error('invalid_grant'), { code: 'RC_REFRESH_EXPIRED' });
  const { job, restore } = loadJob({
    recruiters: [oauthRow(1, 'Jane'), oauthRow(2, 'Bob')],
    refresh: async (recruiter) => {
      if (recruiter.id === 1) throw expired;
      return { accessToken: 'a', expiresIn: 3600 };
    },
  });
  try {
    const summary = await job.refreshAllRecruiterTokens({ delayMs: 0 });
    assert.deepEqual(summary.needsLogin, ['Jane'], 'a person has to fix this, not a retry');
    assert.deepEqual(summary.errors, [], 'and it is not noise in the error list');
    assert.equal(summary.failed, 1);
    assert.equal(summary.refreshed, 1);
  } finally { restore(); }
});

test('a nameless recruiter is still identifiable in the report', async () => {
  const expired = Object.assign(new Error('invalid_grant'), { code: 'RC_REFRESH_EXPIRED' });
  const { job, restore } = loadJob({
    recruiters: [{ id: 42, refresh_token_encrypted: 'enc' }],
    refresh: async () => { throw expired; },
  });
  try {
    const summary = await job.refreshAllRecruiterTokens({ delayMs: 0 });
    assert.deepEqual(summary.needsLogin, ['#42']);
  } finally { restore(); }
});

test('nothing to do is not an error', async () => {
  const { job, refreshed, restore } = loadJob({ recruiters: [jwtRow(1, 'Bob')] });
  try {
    const summary = await job.refreshAllRecruiterTokens({ delayMs: 0 });
    assert.deepEqual(summary, { checked: 0, refreshed: 0, failed: 0, needsLogin: [], errors: [] });
    assert.deepEqual(refreshed, []);
  } finally { restore(); }
});

test('an unreachable database or settings row degrades to a reported no-op', async () => {
  const listFail = loadJob({ listError: new Error('connect ECONNREFUSED') });
  try {
    const summary = await listFail.job.refreshAllRecruiterTokens({ delayMs: 0 });
    assert.equal(summary.checked, 0);
    assert.match(summary.errors[0], /Could not list recruiters/);
  } finally { listFail.restore(); }

  const cfgFail = loadJob({ recruiters: [oauthRow(1, 'Jane')], cfgError: new Error('no settings') });
  try {
    const summary = await cfgFail.job.refreshAllRecruiterTokens({ delayMs: 0 });
    assert.equal(summary.checked, 0);
    assert.match(summary.errors[0], /settings unavailable/i);
  } finally { cfgFail.restore(); }
});

test('the job runs daily and stops cleanly', async () => {
  const { job, refreshed, restore } = loadJob({ recruiters: [oauthRow(1, 'Jane')] });
  try {
    assert.equal(job.REFRESH_INTERVAL_MS, 24 * 60 * 60 * 1000);
    job.startRingCentralTokenRefreshService();
    // The first pass runs immediately: a restart after days of downtime must
    // not wait another day to renew.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(refreshed, [1]);
    job.stopRingCentralTokenRefreshService();
  } finally {
    restore();
  }
});
