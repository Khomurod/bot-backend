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
const IDENTITY_PATH = require.resolve('../services/recruiterExtensionIdentity');
const JOB_PATH = require.resolve('../services/ringCentralTokenRefreshService');

const CFG = { apiBase: 'https://rc.test', clientId: 'cid', clientSecret: 'sec' };

function loadJob({
  recruiters = [],
  refresh = async () => ({ accessToken: 'a', expiresIn: 3600 }),
  listError = null,
  cfgError = null,
  // The extension backfill this job also performs. `backfill` stands in for
  // the RingCentral read; returning an id means "recorded".
  backfill = async (recruiter) => `ext-${recruiter.id}`,
} = {}) {
  const refreshed = [];
  const identified = [];
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
  require.cache[IDENTITY_PATH] = {
    exports: {
      // The real predicate — a row is "missing" its identity when the column
      // is blank. Kept honest rather than stubbed to a constant.
      needsExtensionIdentity: (row) => Boolean(row?.id) && !String(row.rc_extension_id || '').trim(),
      backfillExtensionIdentity: async (recruiter, cfg) => {
        identified.push(recruiter.id);
        return backfill(recruiter, cfg);
      },
      rememberExtensionIdentity: async () => null,
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
    for (const path of [RC_PATH, OAUTH_PATH, IDENTITY_PATH, JOB_PATH]) delete require.cache[path];
  };
  return { job, refreshed, identified, restore };
}

// `rc_extension_id` present by default: the identity backfill is a separate
// concern from token refresh, and these rows are about refresh. The tests that
// exercise the backfill leave it out on purpose.
const oauthRow = (id, name) => ({ id, name, refresh_token_encrypted: 'enc', rc_extension_id: `ext-${id}` });
const jwtRow = (id, name) => ({ id, name, jwt_token_encrypted: 'enc', rc_extension_id: `ext-${id}` });

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
    assert.deepEqual(summary, {
      checked: 0, refreshed: 0, failed: 0, identified: 0, missingIdentity: 0,
      needsLogin: [], errors: [],
    });
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

// ── the extension identity, which is what makes recruiter replies route ──

const jwtNoIdentity = (id, name) => ({ id, name, jwt_token_encrypted: 'enc' });
const oauthNoIdentity = (id, name) => ({ id, name, refresh_token_encrypted: 'enc' });

test('a JWT recruiter with no extension identity gets one — the reply-routing gap', async () => {
  // The hole this closes: `rc_extension_id` was written ONLY by the OAuth
  // sign-in callback, so an admin-pasted JWT left it NULL. Those recruiters
  // sent SMS perfectly and were then dropped from the inbound-SMS
  // subscription, so every driver reply to their number reached nobody.
  // Refresh has nothing to do for a JWT — but the identity does.
  const { job, refreshed, identified, restore } = loadJob({
    recruiters: [jwtNoIdentity(1, 'Bob')],
  });
  try {
    const summary = await job.refreshAllRecruiterTokens({ delayMs: 0 });
    assert.deepEqual(refreshed, [], 'a JWT is not refreshed');
    assert.deepEqual(identified, [1], 'but its extension is read');
    assert.equal(summary.missingIdentity, 1);
    assert.equal(summary.identified, 1);
    assert.equal(summary.checked, 0, 'and it is still not counted as a refresh');
  } finally { restore(); }
});

test('a recruiter who already has an identity costs no request', async () => {
  const { job, identified, restore } = loadJob({
    recruiters: [jwtRow(1, 'Bob'), oauthRow(2, 'Jane')],
  });
  try {
    const summary = await job.refreshAllRecruiterTokens({ delayMs: 0 });
    assert.deepEqual(identified, [], 'nothing to look up');
    assert.equal(summary.missingIdentity, 0);
  } finally { restore(); }
});

test('an OAuth recruiter is refreshed AND identified in one pass', async () => {
  const { job, refreshed, identified, restore } = loadJob({
    recruiters: [oauthNoIdentity(3, 'Ada')],
  });
  try {
    const summary = await job.refreshAllRecruiterTokens({ delayMs: 0 });
    assert.deepEqual(refreshed, [3]);
    assert.deepEqual(identified, [3]);
    assert.equal(summary.refreshed, 1);
    assert.equal(summary.identified, 1);
  } finally { restore(); }
});

test('a dead grant is not asked for its extension as well', async () => {
  // Asking with a credential we just watched fail would log a second,
  // confusing failure for the same recruiter and teach an operator nothing.
  const expired = Object.assign(new Error('invalid_grant'), { code: 'RC_REFRESH_EXPIRED' });
  const { job, identified, restore } = loadJob({
    recruiters: [oauthNoIdentity(4, 'Zoe')],
    refresh: async () => { throw expired; },
  });
  try {
    const summary = await job.refreshAllRecruiterTokens({ delayMs: 0 });
    assert.deepEqual(summary.needsLogin, ['Zoe']);
    assert.deepEqual(identified, [], 'no extension read on a dead credential');
    assert.equal(summary.missingIdentity, 0);
  } finally { restore(); }
});

test('a failed extension read is reported, and does not stop the others', async () => {
  const { job, identified, restore } = loadJob({
    recruiters: [jwtNoIdentity(5, 'Kim'), jwtNoIdentity(6, 'Lee')],
    backfill: async (recruiter) => {
      if (recruiter.id === 5) throw new Error('403 forbidden');
      return `ext-${recruiter.id}`;
    },
  });
  try {
    const summary = await job.refreshAllRecruiterTokens({ delayMs: 0 });
    assert.deepEqual(identified, [5, 6], 'both were attempted');
    assert.equal(summary.missingIdentity, 2);
    assert.equal(summary.identified, 1, 'one succeeded');
    assert.equal(summary.errors.length, 1);
    assert.match(summary.errors[0], /Kim/);
    // The consequence has to be in the message: a bare "403" does not tell an
    // operator that a recruiter's driver replies are going nowhere.
    assert.match(summary.errors[0], /replies will not be mirrored/i);
  } finally { restore(); }
});

test('a recruiter with no credentials at all is skipped entirely', async () => {
  const { job, refreshed, identified, restore } = loadJob({
    recruiters: [{ id: 9, name: 'Nobody' }],
  });
  try {
    const summary = await job.refreshAllRecruiterTokens({ delayMs: 0 });
    assert.deepEqual(refreshed, []);
    assert.deepEqual(identified, [], 'there is no credential to ask with');
    assert.equal(summary.missingIdentity, 0);
  } finally { restore(); }
});
