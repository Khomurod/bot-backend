/**
 * Per-recruiter RingCentral OAuth: getting a token, and — the part that breaks
 * a week later if it is wrong — keeping one.
 *
 * A refresh grant returns a NEW refresh token and kills the one used. Storing
 * the rotation is therefore not bookkeeping: skip it and the recruiter works
 * once, then silently stops sending and their leads quietly go out from the
 * shared number. That is what most of these tests are about.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

const RC_PATH = require.resolve('../database/ringcentral');
const CALL_PATH = require.resolve('../services/ringCentralCallService');
const OAUTH_PATH = require.resolve('../services/ringCentralOAuthService');

const CFG = { apiBase: 'https://rc.test', clientId: 'cid', clientSecret: 'sec' };

function loadOAuth({ auth, jwtToken = 'jwt-access-token' } = {}) {
  const writes = { rotations: [], authErrors: [] };
  require.cache[RC_PATH] = {
    exports: {
      resolveRecruiterRcAuth: () => auth,
      updateRecruiterRefreshToken: async (id, token) => { writes.rotations.push({ id, token }); },
      markRecruiterAuthError: async (id, message) => { writes.authErrors.push({ id, message }); },
    },
  };
  require.cache[CALL_PATH] = { exports: { getAccessToken: async () => jwtToken } };
  delete require.cache[OAUTH_PATH];
  const oauth = require(OAUTH_PATH);
  const restore = () => {
    delete require.cache[RC_PATH];
    delete require.cache[CALL_PATH];
    delete require.cache[OAUTH_PATH];
  };
  return { oauth, writes, restore };
}

function tokenFetch(responses) {
  const seen = [];
  const original = global.fetch;
  let i = 0;
  global.fetch = async (url, options) => {
    seen.push({
      url: String(url),
      auth: options?.headers?.Authorization,
      body: Object.fromEntries(new URLSearchParams(options?.body || '')),
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return typeof next === 'function' ? next() : next;
  };
  return { seen, restore: () => { global.fetch = original; } };
}

const okToken = (refresh = 'refresh-2', access = 'access-1', expiresIn = 3600) => ({
  ok: true,
  status: 200,
  json: async () => ({ access_token: access, refresh_token: refresh, expires_in: expiresIn }),
});

test('the authorize URL carries exactly what RingCentral needs, and no secret', () => {
  const { oauth, restore } = loadOAuth({ auth: {} });
  try {
    const url = new URL(oauth.buildAuthorizeUrl({
      apiBase: 'https://rc.test/',
      clientId: 'cid',
      redirectUri: 'https://app.test/ringcentral/oauth/callback',
      state: 'st8',
    }));
    assert.equal(url.origin + url.pathname, 'https://rc.test/restapi/oauth/authorize');
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), 'cid');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://app.test/ringcentral/oauth/callback');
    assert.equal(url.searchParams.get('state'), 'st8');
    assert.ok(!url.search.includes('sec'), 'the client secret never goes in a browser URL');
  } finally { restore(); }
});

test('the redirect URI is derived in one place, and refuses to be guessed', () => {
  const { oauth, restore } = loadOAuth({ auth: {} });
  try {
    assert.equal(
      oauth.buildRedirectUri('https://app.test/'),
      'https://app.test/ringcentral/oauth/callback',
      'a trailing slash must not change the URI RingCentral has registered',
    );
    assert.throws(() => oauth.buildRedirectUri(''), /RENDER_EXTERNAL_URL/);
    assert.throws(() => oauth.buildRedirectUri(null), (err) => err.code === 'RC_NO_PUBLIC_URL');
  } finally { restore(); }
});

test('exchanging the code posts the grant with Basic client auth', async () => {
  const { oauth, restore } = loadOAuth({ auth: {} });
  const fetchSpy = tokenFetch([okToken('refresh-1', 'access-1')]);
  try {
    const tokens = await oauth.exchangeAuthorizationCode({
      ...CFG, code: 'the-code', redirectUri: 'https://app.test/cb',
    });
    assert.deepEqual(
      { access: tokens.accessToken, refresh: tokens.refreshToken, expires: tokens.expiresIn },
      { access: 'access-1', refresh: 'refresh-1', expires: 3600 },
    );
    const [call] = fetchSpy.seen;
    assert.equal(call.url, 'https://rc.test/restapi/oauth/token');
    assert.equal(call.auth, `Basic ${Buffer.from('cid:sec').toString('base64')}`);
    assert.deepEqual(call.body, {
      grant_type: 'authorization_code',
      code: 'the-code',
      redirect_uri: 'https://app.test/cb',
    });
  } finally { fetchSpy.restore(); restore(); }
});

test('a refresh STORES the rotated token before the access token is used', async () => {
  const auth = { mode: 'oauth', refreshToken: 'refresh-1', ...CFG };
  const { oauth, writes, restore } = loadOAuth({ auth });
  const fetchSpy = tokenFetch([okToken('refresh-2', 'access-2')]);
  try {
    const result = await oauth.getRecruiterAccessToken({ id: 7, name: 'Jane' }, CFG);
    assert.equal(result.accessToken, 'access-2');
    assert.equal(result.mode, 'oauth');
    assert.deepEqual(writes.rotations, [{ id: 7, token: 'refresh-2' }],
      'the old refresh token is already dead — the new one must be persisted');
    assert.deepEqual(fetchSpy.seen[0].body, { grant_type: 'refresh_token', refresh_token: 'refresh-1' });
    assert.deepEqual(writes.authErrors, []);
  } finally { fetchSpy.restore(); restore(); }
});

test('the access token is cached per recruiter, so a burst of leads is one refresh', async () => {
  const auth = { mode: 'oauth', refreshToken: 'refresh-1', ...CFG };
  const { oauth, restore } = loadOAuth({ auth });
  const fetchSpy = tokenFetch([okToken('refresh-2', 'access-2')]);
  try {
    const first = await oauth.getRecruiterAccessToken({ id: 7 }, CFG);
    const second = await oauth.getRecruiterAccessToken({ id: 7 }, CFG);
    assert.equal(first.accessToken, second.accessToken);
    assert.equal(fetchSpy.seen.length, 1, 'the second send reuses the cached token');

    // A different recruiter must never share a token.
    await oauth.getRecruiterAccessToken({ id: 8 }, CFG);
    assert.equal(fetchSpy.seen.length, 2);
  } finally { fetchSpy.restore(); restore(); }
});

test('concurrent callers share ONE grant instead of racing on a rotating token', async () => {
  // The bug this prevents: two callers refresh with the same stored token, the
  // second presents one the first already spent, gets invalid_grant, and a
  // perfectly healthy recruiter is marked as needing to sign in again. It is
  // not hypothetical — the call-log sync and the daily refresh job both start
  // at boot, and two leads can be assigned to the same recruiter seconds apart.
  const auth = { mode: 'oauth', refreshToken: 'refresh-1', ...CFG };
  const { oauth, writes, restore } = loadOAuth({ auth });

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    seen.push(Object.fromEntries(new URLSearchParams(options?.body || '')));
    await gate;
    return { ok: true, status: 200, json: async () => ({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600 }) };
  };

  try {
    const both = Promise.all([
      oauth.getRecruiterAccessToken({ id: 7, name: 'Jane' }, CFG),
      oauth.refreshRecruiterTokens({ id: 7, name: 'Jane' }, auth),
    ]);
    release();
    const [viaAccessToken, viaRefresh] = await both;

    assert.equal(seen.length, 1, 'exactly one grant reached RingCentral');
    assert.equal(viaAccessToken.accessToken, 'access-2');
    assert.equal(viaRefresh.accessToken, 'access-2', 'both callers got the same token');
    assert.deepEqual(writes.rotations, [{ id: 7, token: 'refresh-2' }], 'stored once');
    assert.deepEqual(writes.authErrors, [], 'and nobody was wrongly flagged');
  } finally { global.fetch = original; restore(); }
});

test('a refresh that fails rejects every waiting caller, and flags once', async () => {
  const auth = { mode: 'oauth', refreshToken: 'stale', ...CFG };
  const { oauth, writes, restore } = loadOAuth({ auth });
  const fetchSpy = tokenFetch([{
    ok: false,
    status: 400,
    json: async () => ({ error: 'invalid_grant', error_description: 'Token not found' }),
  }]);
  try {
    const results = await Promise.allSettled([
      oauth.getRecruiterAccessToken({ id: 7, name: 'Jane' }, CFG),
      oauth.getRecruiterAccessToken({ id: 7, name: 'Jane' }, CFG),
    ]);
    assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
    assert.equal(fetchSpy.seen.length, 1);
    assert.equal(writes.authErrors.length, 1, 'flagged once, not once per caller');
  } finally { fetchSpy.restore(); restore(); }
});

test('the dedupe is per recruiter, not global', async () => {
  const auth = { mode: 'oauth', refreshToken: 'refresh-1', ...CFG };
  const { oauth, restore } = loadOAuth({ auth });
  const fetchSpy = tokenFetch([okToken('r2', 'a1'), okToken('r3', 'a2')]);
  try {
    await Promise.all([
      oauth.getRecruiterAccessToken({ id: 7 }, CFG),
      oauth.getRecruiterAccessToken({ id: 8 }, CFG),
    ]);
    assert.equal(fetchSpy.seen.length, 2, 'two recruiters must not block each other');
  } finally { fetchSpy.restore(); restore(); }
});

test('a later refresh is not deduped against a finished one', async () => {
  const auth = { mode: 'oauth', refreshToken: 'refresh-1', ...CFG };
  const { oauth, restore } = loadOAuth({ auth });
  const fetchSpy = tokenFetch([okToken('r2', 'a1'), okToken('r3', 'a2')]);
  try {
    await oauth.refreshRecruiterTokens({ id: 7 }, auth);
    await oauth.refreshRecruiterTokens({ id: 7 }, auth);
    assert.equal(fetchSpy.seen.length, 2, 'the in-flight entry must be released');
  } finally { fetchSpy.restore(); restore(); }
});

test('a caller holding a row loaded BEFORE the rotation still hits the cache', async () => {
  // Why the cache is keyed by recruiter and not by the credential: callers pass
  // a row they loaded earlier, so after a rotation their row's refresh token is
  // stale. A credential-keyed cache would miss and send that spent token back.
  const staleAuth = { mode: 'oauth', refreshToken: 'refresh-1', ...CFG };
  const { oauth, restore } = loadOAuth({ auth: staleAuth });
  const fetchSpy = tokenFetch([okToken('refresh-2', 'access-2')]);
  try {
    await oauth.getRecruiterAccessToken({ id: 7 }, CFG);
    await oauth.getRecruiterAccessToken({ id: 7 }, CFG);
    assert.equal(fetchSpy.seen.length, 1, 'the second call must not refresh a spent token');
  } finally { fetchSpy.restore(); restore(); }
});

test('clearing the cache is what makes a re-authorization take effect', async () => {
  // The cost of keying by recruiter: a NEW login must invalidate explicitly, or
  // the previous account's access token keeps being used until it expires and
  // every send is rejected. The connect flow and the "forget sign-in" route
  // both call clearRecruiterTokenCache for exactly this reason.
  const auth = { mode: 'oauth', refreshToken: 'refresh-1', ...CFG };
  const { oauth, restore } = loadOAuth({ auth });
  const fetchSpy = tokenFetch([okToken('r2', 'access-old'), okToken('r3', 'access-new')]);
  try {
    const before = await oauth.getRecruiterAccessToken({ id: 7 }, CFG);
    assert.equal(before.accessToken, 'access-old');

    oauth.clearRecruiterTokenCache(7);
    const after = await oauth.getRecruiterAccessToken({ id: 7 }, CFG);
    assert.equal(after.accessToken, 'access-new');
    assert.equal(fetchSpy.seen.length, 2);

    // And a different recruiter's cache is untouched by that clear.
    oauth.clearRecruiterTokenCache(999);
    const still = await oauth.getRecruiterAccessToken({ id: 7 }, CFG);
    assert.equal(still.accessToken, 'access-new');
    assert.equal(fetchSpy.seen.length, 2);
  } finally { fetchSpy.restore(); restore(); }
});

test('the nightly job warms the cache instead of leaving the next send to refresh', async () => {
  const auth = { mode: 'oauth', refreshToken: 'refresh-1', ...CFG };
  const { oauth, restore } = loadOAuth({ auth });
  const fetchSpy = tokenFetch([okToken('r2', 'access-2')]);
  try {
    await oauth.refreshRecruiterTokens({ id: 7 }, auth);
    const next = await oauth.getRecruiterAccessToken({ id: 7 }, CFG);
    assert.equal(next.accessToken, 'access-2');
    assert.equal(fetchSpy.seen.length, 1, 'the send after a job refresh costs no grant');
  } finally { fetchSpy.restore(); restore(); }
});

test('a token about to expire is refreshed rather than used', async () => {
  const auth = { mode: 'oauth', refreshToken: 'refresh-1', ...CFG };
  const { oauth, restore } = loadOAuth({ auth });
  // expires_in below the skew window: never cache-hit.
  const fetchSpy = tokenFetch([okToken('r2', 'a1', 5), okToken('r3', 'a2', 5)]);
  try {
    await oauth.getRecruiterAccessToken({ id: 7 }, CFG);
    await oauth.getRecruiterAccessToken({ id: 7 }, CFG);
    assert.equal(fetchSpy.seen.length, 2, 'a token inside the skew window is not reused');
  } finally { fetchSpy.restore(); restore(); }
});

test('an expired grant is flagged on the recruiter as "must sign in again"', async () => {
  const auth = { mode: 'oauth', refreshToken: 'stale', ...CFG };
  const { oauth, writes, restore } = loadOAuth({ auth });
  const fetchSpy = tokenFetch([{
    ok: false,
    status: 400,
    json: async () => ({ error: 'invalid_grant', error_description: 'Token not found' }),
  }]);
  try {
    await assert.rejects(
      () => oauth.getRecruiterAccessToken({ id: 7, name: 'Jane' }, CFG),
      (err) => err.code === 'RC_REFRESH_EXPIRED',
    );
    assert.equal(writes.rotations.length, 0, 'nothing to rotate when the grant is dead');
    assert.equal(writes.authErrors.length, 1);
    assert.match(writes.authErrors[0].message, /connect RingCentral again/i);
  } finally { fetchSpy.restore(); restore(); }
});

test('any other auth failure is recorded verbatim, not mislabelled as expired', async () => {
  const auth = { mode: 'oauth', refreshToken: 'r', ...CFG };
  const { oauth, writes, restore } = loadOAuth({ auth });
  const fetchSpy = tokenFetch([{
    ok: false,
    status: 503,
    json: async () => ({ error: 'server_error', error_description: 'Service unavailable' }),
  }]);
  try {
    await assert.rejects(
      () => oauth.getRecruiterAccessToken({ id: 7 }, CFG),
      (err) => err.code === 'RC_AUTH_FAILED' && err.status === 503,
    );
    assert.match(writes.authErrors[0].message, /Service unavailable/);
  } finally { fetchSpy.restore(); restore(); }
});

test('a JWT recruiter is delegated to the one JWT implementation', async () => {
  const auth = { mode: 'jwt', jwtToken: 'the-jwt', ...CFG };
  const { oauth, writes, restore } = loadOAuth({ auth, jwtToken: 'jwt-access' });
  const fetchSpy = tokenFetch([okToken()]);
  try {
    const result = await oauth.getRecruiterAccessToken({ id: 7 }, CFG);
    assert.deepEqual({ token: result.accessToken, mode: result.mode }, { token: 'jwt-access', mode: 'jwt' });
    assert.equal(fetchSpy.seen.length, 0, 'ringCentralCallService owns that grant, not this module');
    assert.deepEqual(writes.rotations, [], 'JWTs do not rotate');
  } finally { fetchSpy.restore(); restore(); }
});

test('a recruiter with no credentials fails loudly instead of returning nothing', async () => {
  const { oauth, restore } = loadOAuth({ auth: { mode: 'none', ...CFG } });
  try {
    await assert.rejects(
      () => oauth.getRecruiterAccessToken({ id: 7, name: 'Jane' }, CFG),
      (err) => err.code === 'RC_NO_RECRUITER_CREDENTIALS' && /Jane/.test(err.message),
    );
    await assert.rejects(
      () => oauth.getRecruiterAccessToken(null, CFG),
      (err) => err.code === 'RC_NO_RECRUITER',
    );
  } finally { restore(); }
});

test('a token response with no access_token is a failure, not an empty success', async () => {
  const auth = { mode: 'oauth', refreshToken: 'r', ...CFG };
  const { oauth, restore } = loadOAuth({ auth });
  const fetchSpy = tokenFetch([{ ok: true, status: 200, json: async () => ({ token_type: 'bearer' }) }]);
  try {
    await assert.rejects(() => oauth.getRecruiterAccessToken({ id: 7 }, CFG), /OAuth failed/);
  } finally { fetchSpy.restore(); restore(); }
});

test('missing client credentials are refused before any request', async () => {
  const { oauth, restore } = loadOAuth({ auth: {} });
  const fetchSpy = tokenFetch([okToken()]);
  try {
    await assert.rejects(
      () => oauth.refreshAccessToken({ apiBase: 'https://rc.test', clientId: '', clientSecret: '', refreshToken: 'r' }),
      (err) => err.code === 'RC_NOT_CONFIGURED',
    );
    assert.equal(fetchSpy.seen.length, 0);
  } finally { fetchSpy.restore(); restore(); }
});
