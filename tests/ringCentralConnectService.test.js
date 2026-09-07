/**
 * The recruiter self-onboarding flow: one link, one sign-in, no secret changing
 * hands.
 *
 * Two properties matter here and they pull in opposite directions:
 *   • it must be EASY — a new recruiter opens a link and ends up on the
 *     platform with the right number, read from RingCentral rather than typed;
 *   • it must be SAFE — the routes carry no admin session, so the link itself
 *     is the credential: single-use, expiring, and bound to the callback by
 *     `oauth_state`.
 *
 * The mismatch case gets its own test because it is the one that silently
 * costs sending later: a login for the wrong extension authenticates fine and
 * then has every send rejected.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';
process.env.RENDER_EXTERNAL_URL ||= 'https://app.test';

const CONFIG_PATH = require.resolve('../config/config');
const RC_PATH = require.resolve('../database/ringcentral');
const CALL_PATH = require.resolve('../services/ringCentralCallService');
const OAUTH_PATH = require.resolve('../services/ringCentralOAuthService');
const CONNECT_PATH = require.resolve('../services/ringCentralConnectService');

const EXT = {
  extensionId: '101',
  extensionNumber: '1001',
  name: 'Jane Doe',
  phoneNumbers: ['+15550001111'],
  phoneNumberDetails: [{ phoneNumber: '+15550001111', usageType: 'DirectNumber', features: ['SmsSender'] }],
  smsNumber: '+15550001111',
};

const future = () => new Date(Date.now() + 60_000);

function loadConnect({
  sessions = {},
  recruiters = {},
  extension = EXT,
  publicBaseUrl = 'https://app.test',
  tokens = { accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600 },
  cfg = { apiBase: 'https://rc.test', clientId: 'cid', clientSecret: 'sec' },
} = {}) {
  const calls = { states: [], stored: [], created: [], completed: [], errors: [], authErrors: [], expired: 0 };
  let nextId = 90;

  require.cache[CONFIG_PATH] = { exports: { ...require('../config/config'), publicBaseUrl } };
  require.cache[RC_PATH] = {
    exports: {
      getRcConfig: async () => cfg,
      normalizePhone: (v) => String(v || '').replace(/\D/g, '').slice(-10),
      getRecruiterById: async (id) => recruiters[id] || null,
      getRecruiterByNormalizedNumber: async (norm) => Object.values(recruiters)
        .find((r) => String(r.phone_number || '').replace(/\D/g, '').slice(-10) === norm) || null,
      expireOldRcConnectSessions: async () => { calls.expired += 1; },
      createRcConnectSession: async (row) => {
        const session = { id: nextId += 1, status: 'pending', ...row, expires_at: row.expiresAt };
        sessions[row.sessionToken] = session;
        return session;
      },
      getRcConnectSessionByToken: async (token) => sessions[token] || null,
      getRcConnectSessionByOAuthState: async (state) => Object.values(sessions)
        .find((s) => s.oauth_state === state) || null,
      setRcConnectSessionOAuthState: async (id, state) => {
        calls.states.push({ id, state });
        const session = Object.values(sessions).find((s) => s.id === id);
        if (session) session.oauth_state = state;
      },
      completeRcConnectSession: async (id, recruiterId) => { calls.completed.push({ id, recruiterId }); },
      markRcConnectSessionError: async (id, message) => { calls.errors.push({ id, message }); },
      storeRecruiterOAuthTokens: async (id, payload) => {
        calls.stored.push({ id, ...payload });
        return recruiters[id];
      },
      markRecruiterAuthError: async (id, message) => { calls.authErrors.push({ id, message }); },
      createRecruiter: async (payload) => {
        const id = nextId += 1;
        calls.created.push(payload);
        recruiters[id] = {
          id,
          name: payload.name,
          phone_number: payload.phoneNumber,
          rc_extension_id: payload.rcExtensionId,
        };
        return { id };
      },
    },
  };
  require.cache[CALL_PATH] = {
    exports: {
      getExtensionInfoWithToken: async () => {
        if (extension instanceof Error) throw extension;
        return extension;
      },
    },
  };
  require.cache[OAUTH_PATH] = {
    exports: {
      buildRedirectUri: (base) => `${String(base).replace(/\/+$/, '')}/ringcentral/oauth/callback`,
      buildAuthorizeUrl: ({ redirectUri, state }) => `https://rc.test/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
      exchangeAuthorizationCode: async () => {
        if (tokens instanceof Error) throw tokens;
        return tokens;
      },
    },
  };
  delete require.cache[CONNECT_PATH];
  const connect = require(CONNECT_PATH);
  const restore = () => {
    for (const path of [CONFIG_PATH, RC_PATH, CALL_PATH, OAUTH_PATH, CONNECT_PATH]) delete require.cache[path];
  };
  return { connect, calls, sessions, recruiters, restore };
}

test('an invite link is public, personal and short-lived', async () => {
  const { connect, sessions, restore } = loadConnect();
  try {
    const { connectUrl, expiresAt } = await connect.createRecruiterConnectLink({
      invitedName: 'Jane Doe', createdBy: 'admin',
    });
    assert.match(connectUrl, /^https:\/\/app\.test\/ringcentral\/connect\/[A-Za-z0-9_-]{10,}$/);
    const token = connectUrl.split('/').pop();
    assert.equal(sessions[token].invited_name ?? sessions[token].invitedName, 'Jane Doe');
    const ttl = expiresAt.getTime() - Date.now();
    assert.ok(ttl > 0 && ttl <= connect.CONNECT_SESSION_TTL_MS, 'the link must expire');
  } finally { restore(); }
});

test('an invite is refused while the shared app credentials are missing', async () => {
  const { connect, restore } = loadConnect({ cfg: { apiBase: 'https://rc.test', clientId: '', clientSecret: '' } });
  try {
    await assert.rejects(() => connect.createRecruiterConnectLink({}), /Client ID and Secret/i);
  } finally { restore(); }
});

test('a used, expired or unknown link is refused', async () => {
  const sessions = {
    used: { id: 1, session_token: 'used', status: 'completed', expires_at: future() },
    old: { id: 2, session_token: 'old', status: 'pending', expires_at: new Date(Date.now() - 1000) },
    flagged: { id: 3, session_token: 'flagged', status: 'expired', expires_at: future() },
  };
  const { connect, restore } = loadConnect({ sessions });
  try {
    await assert.rejects(() => connect.getConnectSession('used'), /already been used/i);
    await assert.rejects(() => connect.getConnectSession('old'), /expired/i);
    await assert.rejects(() => connect.getConnectSession('flagged'), /expired/i);
    await assert.rejects(() => connect.getConnectSession('nope'), /not found/i);
  } finally { restore(); }
});

test('the redirect stores a fresh state and points at the registered URI', async () => {
  const sessions = { tok: { id: 5, session_token: 'tok', status: 'pending', expires_at: future() } };
  const { connect, calls, restore } = loadConnect({ sessions });
  try {
    const url = await connect.buildConnectRedirect('tok');
    assert.equal(calls.states.length, 1);
    const state = calls.states[0].state;
    assert.ok(state && state.length >= 10, 'the CSRF state must be unguessable');
    assert.match(url, new RegExp(`state=${state}$`));
    assert.match(decodeURIComponent(url), /redirect_uri=https:\/\/app\.test\/ringcentral\/oauth\/callback/);

    // A second visit re-states: an old redirect can never be replayed.
    await connect.buildConnectRedirect('tok');
    assert.notEqual(calls.states[1].state, state);
  } finally { restore(); }
});

test('an unbound link creates the recruiter from the extension that signed in', async () => {
  const sessions = { tok: { id: 5, session_token: 'tok', status: 'pending', oauth_state: 'st8', expires_at: future(), invited_name: 'Jane Doe' } };
  const { connect, calls, restore } = loadConnect({ sessions });
  try {
    const result = await connect.finishConnectCallback({ state: 'st8', code: 'code-1' });
    assert.equal(result.created, true);
    assert.equal(result.warning, null);
    // The number is READ, not typed — that is the whole point of the flow.
    assert.deepEqual(calls.created, [{
      name: 'Jane Doe',
      phoneNumber: '+15550001111',
      refreshToken: 'refresh-1',
      rcExtensionId: '101',
      rcExtensionNumber: '1001',
    }]);
    assert.equal(calls.completed.length, 1, 'the link is consumed');
    assert.equal(calls.completed[0].recruiterId, result.recruiter.id);
  } finally { restore(); }
});

test('an unbound link finds an EXISTING recruiter by their number instead of duplicating', async () => {
  const recruiters = { 7: { id: 7, name: 'Jane Doe', phone_number: '+1 (555) 000-1111' } };
  const sessions = { tok: { id: 5, session_token: 'tok', status: 'pending', oauth_state: 'st8', expires_at: future() } };
  const { connect, calls, restore } = loadConnect({ sessions, recruiters });
  try {
    const result = await connect.finishConnectCallback({ state: 'st8', code: 'code-1' });
    assert.equal(result.created, false);
    assert.equal(result.recruiter.id, 7);
    assert.deepEqual(calls.created, [], 'no duplicate row for a number already on the platform');
    assert.deepEqual(calls.stored, [{ id: 7, refreshToken: 'refresh-1', extensionId: '101', extensionNumber: '1001' }]);
  } finally { restore(); }
});

test('a bound link stores the login on the recruiter it was made for', async () => {
  const recruiters = { 7: { id: 7, name: 'Jane Doe', phone_number: '+15550001111' } };
  const sessions = { tok: { id: 5, session_token: 'tok', recruiter_id: 7, status: 'pending', oauth_state: 'st8', expires_at: future() } };
  const { connect, calls, restore } = loadConnect({ sessions, recruiters });
  try {
    const result = await connect.finishConnectCallback({ state: 'st8', code: 'code-1' });
    assert.equal(result.created, false);
    assert.equal(result.warning, null);
    assert.deepEqual(calls.stored, [{ id: 7, refreshToken: 'refresh-1', extensionId: '101', extensionNumber: '1001' }]);
    assert.deepEqual(calls.authErrors, []);
  } finally { restore(); }
});

test('signing in as the WRONG extension is flagged, not accepted quietly', async () => {
  // Authenticates fine; every send would then be rejected by RingCentral.
  const recruiters = { 7: { id: 7, name: 'Jane Doe', phone_number: '+15559990000' } };
  const sessions = { tok: { id: 5, session_token: 'tok', recruiter_id: 7, status: 'pending', oauth_state: 'st8', expires_at: future() } };
  const { connect, calls, restore } = loadConnect({ sessions, recruiters });
  try {
    const result = await connect.finishConnectCallback({ state: 'st8', code: 'code-1' });
    assert.match(result.warning, /\+15550001111/);
    assert.match(result.warning, /not \+15559990000/);
    assert.equal(calls.stored.length, 1, 'the login is still stored — it is valid, just mismatched');
    assert.equal(calls.authErrors.length, 1, 'and the admin panel is told');
  } finally { restore(); }
});

test('an extension with no SMS-capable number cannot become a sender', async () => {
  const sessions = { tok: { id: 5, session_token: 'tok', status: 'pending', oauth_state: 'st8', expires_at: future() } };
  const { connect, calls, restore } = loadConnect({
    sessions,
    extension: { ...EXT, smsNumber: null, phoneNumberDetails: [], phoneNumbers: [] },
  });
  try {
    await assert.rejects(
      () => connect.finishConnectCallback({ state: 'st8', code: 'code-1' }),
      /no SMS-capable direct number/i,
    );
    assert.deepEqual(calls.created, []);
    assert.deepEqual(calls.completed, [], 'a failed attempt does not consume the link');
    assert.equal(calls.errors.length, 1, 'but it is recorded on the session');
  } finally { restore(); }
});

test('a refresh-token-less grant is refused with an actionable message', async () => {
  const sessions = { tok: { id: 5, session_token: 'tok', status: 'pending', oauth_state: 'st8', expires_at: future() } };
  const { connect, restore } = loadConnect({
    sessions,
    tokens: { accessToken: 'a', refreshToken: '', expiresIn: 3600 },
  });
  try {
    await assert.rejects(
      () => connect.finishConnectCallback({ state: 'st8', code: 'code-1' }),
      /Refresh Token grant/i,
    );
  } finally { restore(); }
});

test('an unknown state, or a missing code, never reaches RingCentral', async () => {
  const sessions = { tok: { id: 5, session_token: 'tok', status: 'pending', oauth_state: 'st8', expires_at: future() } };
  const { connect, calls, restore } = loadConnect({ sessions });
  try {
    await assert.rejects(() => connect.finishConnectCallback({ state: 'forged', code: 'c' }), /not found/i);
    await assert.rejects(() => connect.finishConnectCallback({ state: 'st8', code: '' }), /authorization code/i);
    assert.deepEqual(calls.stored, []);
    assert.deepEqual(calls.created, []);
  } finally { restore(); }
});

test('the callback URI is the one single definition, in both directions', async () => {
  const { connect, restore } = loadConnect();
  try {
    assert.equal(connect.connectRedirectUri(), 'https://app.test/ringcentral/oauth/callback');
  } finally { restore(); }

  const { connect: noUrl, restore: restoreNoUrl } = loadConnect({ publicBaseUrl: '' });
  try {
    assert.throws(() => noUrl.connectRedirectUri(), /RENDER_EXTERNAL_URL/);
    await assert.rejects(() => noUrl.createRecruiterConnectLink({}), /RENDER_EXTERNAL_URL/);
  } finally { restoreNoUrl(); }
});
