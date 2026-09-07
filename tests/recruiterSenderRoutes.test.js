/**
 * The HTTP surface an operator and a recruiter actually touch.
 *
 * Three things are being guarded:
 *   • the ADMIN routes accept and clear the Bitrix mapping, mint sign-in links
 *     and can prove a number works — behind auth, and never echoing a secret;
 *   • the RECRUITER routes (/ringcentral/connect/*) are public because a
 *     recruiter has no admin session, so the link in the URL is the credential
 *     and a bad one must produce a page, not a stack trace;
 *   • the INTERNAL extension list is refused without the shared secret and
 *     returns ids only.
 *
 * The data layer is stubbed at the pool seam, the way the other recruiter route
 * suites do it, so nothing here reaches a database or RingCentral.
 */
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-secret';
process.env.BOT_TOKEN ||= '123:test-bot-token';
process.env.TELEGRAM_BOT_TOKEN ||= '123:test-bot-token';
process.env.FACEBOOK_TOKEN_ENCRYPTION_KEY ||= 'test-encryption-key';
process.env.RENDER_EXTERNAL_URL ||= 'https://app.test';
process.env.LEADS_INTERNAL_SHARED_SECRET ||= 'internal-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const { purgeDataLayer, POOL_PATH } = require('./helpers/purgeDataLayer');

const ROUTE_PATH = path.resolve(__dirname, '../server/routes/recruiterRoutes.js');
const DIAG_PATH = path.resolve(__dirname, '../server/routes/recruiter/diagnosticsRoutes.js');
const CONNECT_ROUTE_PATH = path.resolve(__dirname, '../server/routes/ringcentralConnect/index.js');
const INTERNAL_PATH = path.resolve(__dirname, '../server/routes/facebookConnect/internalRoutes.js');
const CONNECT_SVC_PATH = path.resolve(__dirname, '../services/ringCentralConnectService.js');
const SMS_PATH = path.resolve(__dirname, '../services/ringCentralSmsService.js');
const SYNC_PATH = path.resolve(__dirname, '../services/recruiterCallSyncService.js');
const OAUTH_PATH = path.resolve(__dirname, '../services/ringCentralOAuthService.js');
const CALL_PATH = path.resolve(__dirname, '../services/ringCentralCallService.js');
const WEBHOOK_PATH = path.resolve(__dirname, '../services/facebookWebhookService.js');
const FB_CONNECT_PATH = path.resolve(__dirname, '../services/facebookConnectService.js');
const LEADS_TG_PATH = path.resolve(__dirname, '../services/leadsTelegramClient.js');
const MIRROR_PATH = path.resolve(__dirname, '../services/facebookLeadSmsMirrorService.js');

const SETTINGS_ROW = {
  id: 1,
  enabled: true,
  api_base: 'https://platform.ringcentral.com',
  client_id_encrypted: null,
  client_secret_encrypted: null,
  jwt_token_encrypted: null,
  poll_minutes: 10,
  timezone: 'America/Chicago',
  target_talk_seconds: 9000,
  target_outbound: 150,
  target_real_conversations: 35,
};

/**
 * A pool stub that records writes. Only the statements these routes issue are
 * answered; anything else throws, so a route quietly changing its SQL is a
 * failing test rather than a silent pass.
 */
function makePool({ recruiters = [], sessions = [] } = {}) {
  const writes = [];
  return {
    writes,
    query: async (sql, params = []) => {
      writes.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/FROM ringcentral_settings/i.test(sql)) return { rows: [SETTINGS_ROW] };
      if (/^SELECT \* FROM recruiters WHERE id/i.test(sql.trim())) {
        return { rows: recruiters.filter((r) => r.id === params[0]) };
      }
      if (/FROM recruiters\s+WHERE\s+active = TRUE\s+AND \(refresh_token_encrypted/i.test(sql)) {
        return { rows: recruiters.filter((r) => r.refresh_token_encrypted || r.jwt_token_encrypted) };
      }
      if (/^SELECT \* FROM recruiters/i.test(sql.trim())) return { rows: recruiters };
      if (/UPDATE recruiters/i.test(sql)) {
        const row = recruiters.find((r) => r.id === params[params.length - 1]) || recruiters[0];
        return { rows: row ? [{ ...row, refresh_token_encrypted: null }] : [] };
      }
      if (/INSERT INTO ringcentral_connect_sessions/i.test(sql)) {
        const row = { id: sessions.length + 1, session_token: params[0], status: 'pending' };
        sessions.push(row);
        return { rows: [row] };
      }
      if (/FROM ringcentral_connect_sessions/i.test(sql)) return { rows: [] };
      if (/UPDATE ringcentral_connect_sessions/i.test(sql)) return { rows: [] };
      throw new Error(`Unexpected query in test: ${sql.slice(0, 90)}`);
    },
  };
}

function loadApp({ pool, connectService, smsService, oauthService, callService } = {}) {
  require.cache[POOL_PATH] = { id: POOL_PATH, filename: POOL_PATH, loaded: true, exports: pool };
  purgeDataLayer([
    ROUTE_PATH, DIAG_PATH, CONNECT_ROUTE_PATH, INTERNAL_PATH,
    CONNECT_SVC_PATH, SMS_PATH, SYNC_PATH, OAUTH_PATH, CALL_PATH,
    WEBHOOK_PATH, FB_CONNECT_PATH, LEADS_TG_PATH, MIRROR_PATH,
  ]);
  require('../database/ringcentral').invalidateSettingsCache();

  if (connectService) require.cache[CONNECT_SVC_PATH] = { exports: connectService };
  if (smsService) require.cache[SMS_PATH] = { exports: smsService };
  if (oauthService) require.cache[OAUTH_PATH] = { exports: oauthService };
  if (callService) require.cache[CALL_PATH] = { exports: callService };
  // Never started in a route test; stubbed so requiring the router is cheap.
  require.cache[SYNC_PATH] = { exports: { syncNow: async () => ({ synced: 0 }) } };

  const { createRecruiterRouter } = require(ROUTE_PATH);
  const { createRingCentralConnectRoutes } = require(CONNECT_ROUTE_PATH);

  const app = express();
  app.use(express.json());
  app.use('/api/recruiters', createRecruiterRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'admin' }; next(); },
  }));
  app.use(createRingCentralConnectRoutes());
  return app;
}

async function call(app, method, pathname, body) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* an HTML page */ }
    return { status: res.status, json, text, location: res.headers.get('location') };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const JANE = {
  id: 7,
  name: 'Jane Doe',
  phone_number: '+15550001111',
  phone_number_normalized: '5550001111',
  active: true,
  bitrix_user_id: 17,
  rc_extension_id: '101',
  jwt_token_encrypted: null,
  client_id_encrypted: null,
  client_secret_encrypted: null,
  refresh_token_encrypted: null,
};

test('the recruiter list exposes the sender state and no secret', async () => {
  const pool = makePool({ recruiters: [JANE] });
  const app = loadApp({ pool });
  const res = await call(app, 'GET', '/api/recruiters');
  assert.equal(res.status, 200);
  const [recruiter] = res.json.recruiters;
  assert.equal(recruiter.bitrixUserId, 17);
  assert.equal(recruiter.authMode, 'none');
  assert.equal(recruiter.canSendSms, false, 'no credentials of their own yet');
  assert.ok(!res.text.includes('refresh_token_encrypted'));
});

test('the Bitrix mapping is settable and clearable through the API', async () => {
  const pool = makePool({ recruiters: [JANE] });
  const app = loadApp({ pool });

  await call(app, 'PUT', '/api/recruiters/7', { bitrixUserId: '23' });
  const set = pool.writes.find((w) => /UPDATE recruiters SET.*bitrix_user_id/i.test(w.sql));
  assert.ok(set, 'the update must reach the column');
  assert.ok(set.params.includes(23), 'a string from the form is stored as an integer');

  pool.writes.length = 0;
  await call(app, 'PUT', '/api/recruiters/7', { bitrixUserId: '' });
  const cleared = pool.writes.find((w) => /UPDATE recruiters SET.*bitrix_user_id/i.test(w.sql));
  assert.ok(cleared.params.includes(null), 'an explicit blank clears the mapping');

  pool.writes.length = 0;
  await call(app, 'PUT', '/api/recruiters/7', { name: 'Jane D.' });
  assert.ok(
    !pool.writes.some((w) => /bitrix_user_id/i.test(w.sql)),
    'an unrelated edit must not touch the mapping',
  );
});

test('a duplicate Bitrix user is refused with a message that names the clash', async () => {
  const pool = makePool({ recruiters: [JANE] });
  pool.query = async (sql) => {
    if (/FROM ringcentral_settings/i.test(sql)) return { rows: [SETTINGS_ROW] };
    const err = new Error('duplicate key value violates unique constraint "idx_recruiters_bitrix_user_id"');
    err.code = '23505';
    err.constraint = 'idx_recruiters_bitrix_user_id';
    throw err;
  };
  const app = loadApp({ pool });
  const res = await call(app, 'POST', '/api/recruiters', {
    name: 'Bob', phoneNumber: '+15550002222', bitrixUserId: 17,
  });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /Bitrix user is already mapped/i);
});

test('a duplicate phone number keeps its own, different message', async () => {
  const pool = makePool({ recruiters: [JANE] });
  pool.query = async (sql) => {
    if (/FROM ringcentral_settings/i.test(sql)) return { rows: [SETTINGS_ROW] };
    const err = new Error('duplicate key value violates unique constraint "recruiters_phone_number_normalized_key"');
    err.code = '23505';
    err.constraint = 'recruiters_phone_number_normalized_key';
    throw err;
  };
  const app = loadApp({ pool });
  const res = await call(app, 'POST', '/api/recruiters', { name: 'Bob', phoneNumber: '+15550001111' });
  assert.equal(res.status, 409);
  assert.match(res.json.error, /phone number is already assigned/i);
});

test('an invite link is minted for an existing recruiter and for a new hire', async () => {
  const asked = [];
  const app = loadApp({
    pool: makePool({ recruiters: [JANE] }),
    connectService: {
      createRecruiterConnectLink: async (args) => {
        asked.push(args);
        return { connectUrl: 'https://app.test/ringcentral/connect/tok-1', expiresAt: new Date() };
      },
    },
  });

  const bound = await call(app, 'POST', '/api/recruiters/connect-link', { recruiterId: 7 });
  assert.equal(bound.status, 200);
  assert.match(bound.json.connectUrl, /\/ringcentral\/connect\/tok-1$/);
  assert.equal(asked[0].recruiterId, 7);
  assert.equal(asked[0].createdBy, 'admin', 'who generated the link is recorded');

  const unbound = await call(app, 'POST', '/api/recruiters/connect-link', { invitedName: 'New Hire' });
  assert.equal(unbound.status, 200);
  assert.equal(asked[1].recruiterId, null, 'an open link binds to whoever signs in');
  assert.equal(asked[1].invitedName, 'New Hire');

  const bad = await call(app, 'POST', '/api/recruiters/connect-link', { recruiterId: 'abc' });
  assert.equal(bad.status, 400);
});

test('a link cannot be minted before the shared app credentials exist', async () => {
  const app = loadApp({
    pool: makePool({ recruiters: [JANE] }),
    connectService: {
      createRecruiterConnectLink: async () => {
        throw new Error('Set the shared RingCentral Client ID and Secret in Settings → RingCentral before inviting a recruiter.');
      },
    },
  });
  const res = await call(app, 'POST', '/api/recruiters/connect-link', {});
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Client ID and Secret/i);
});

test('forgetting a RingCentral sign-in is a distinct, narrow action', async () => {
  const pool = makePool({ recruiters: [{ ...JANE, refresh_token_encrypted: 'enc' }] });
  const cleared = [];
  const app = loadApp({
    pool,
    oauthService: {
      getRecruiterAccessToken: async () => ({ accessToken: 't', apiBase: 'https://rc.test', mode: 'oauth' }),
      clearRecruiterTokenCache: (id) => cleared.push(id),
    },
  });
  const res = await call(app, 'DELETE', '/api/recruiters/7/ringcentral-login');
  assert.equal(res.status, 200);
  const update = pool.writes.find((w) => /refresh_token_encrypted = NULL/i.test(w.sql));
  assert.ok(update, 'only the OAuth grant is cleared');
  assert.ok(!/jwt_token_encrypted/i.test(update.sql), 'a pasted JWT is left alone');
  // Revoking the stored login must revoke the live access token too, or their
  // sends keep working for up to an hour after it was removed.
  assert.deepEqual(cleared, [7]);

  const bad = await call(app, 'DELETE', '/api/recruiters/0/ringcentral-login');
  assert.equal(bad.status, 400);
});

test('the test SMS needs an explicit destination, so it cannot text a driver by accident', async () => {
  const sent = [];
  const app = loadApp({
    pool: makePool({ recruiters: [{ ...JANE, refresh_token_encrypted: 'enc' }] }),
    smsService: {
      sendSms: async () => ({ ok: true }),
      sendSmsAsRecruiter: async (recruiter, to, message) => {
        sent.push({ as: recruiter.id, to, message });
        return { ok: true, fromNumber: recruiter.phone_number, messageId: 'rc-1' };
      },
    },
  });

  for (const body of [{}, { to: '' }, { to: '555' }]) {
    const res = await call(app, 'POST', '/api/recruiters/7/test-sms', body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.deepEqual(sent, [], 'nothing is sent without a full number');

  const ok = await call(app, 'POST', '/api/recruiters/7/test-sms', { to: '+15559998888' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.sent, true);
  assert.match(ok.json.message, /Sent from \+15550001111 to \+15559998888/);
  assert.equal(sent[0].as, 7);
  assert.match(sent[0].message, /Jane Doe/, 'the driver sees who it is from');
});

test('a failed test SMS reports the reason instead of a 500', async () => {
  const app = loadApp({
    pool: makePool({ recruiters: [{ ...JANE, refresh_token_encrypted: 'enc' }] }),
    smsService: {
      sendSms: async () => ({ ok: true }),
      sendSmsAsRecruiter: async () => ({ ok: false, reason: 'recruiter_auth_failed', detail: 'invalid_grant' }),
    },
  });
  const res = await call(app, 'POST', '/api/recruiters/7/test-sms', { to: '+15559998888' });
  assert.equal(res.status, 200);
  assert.equal(res.json.sent, false);
  assert.match(res.json.message, /recruiter_auth_failed: invalid_grant/);
});

test('the connect landing page is public, and a bad link renders a page not a crash', async () => {
  const app = loadApp({
    pool: makePool(),
    connectService: {
      getConnectSession: async (token) => {
        if (token !== 'tok-1') throw new Error('This RingCentral link has expired. Ask for a new one.');
        return {
          session: { id: 1, session_token: 'tok-1', invited_name: 'Jane Doe' },
          recruiter: { id: 7, name: 'Jane Doe', phone_number: '+15550001111' },
        };
      },
      buildConnectRedirect: async () => 'https://platform.ringcentral.com/restapi/oauth/authorize?state=st8',
      finishConnectCallback: async () => { throw new Error('not used here'); },
    },
  });

  // No Authorization header of any kind: a recruiter has no admin session.
  const good = await call(app, 'GET', '/ringcentral/connect/tok-1');
  assert.equal(good.status, 200);
  assert.match(good.text, /Connect RingCentral, Jane Doe/);
  assert.match(good.text, /\+15550001111/);
  assert.match(good.text, /\/ringcentral\/oauth\/start\?session=tok-1/);
  assert.ok(!good.text.includes('client_secret'));

  const expired = await call(app, 'GET', '/ringcentral/connect/nope');
  assert.equal(expired.status, 400);
  assert.match(expired.text, /RingCentral Link Unavailable/);
  assert.match(expired.text, /has expired/);
});

test('the start route redirects to RingCentral, and the callback reports the result', async () => {
  const app = loadApp({
    pool: makePool(),
    connectService: {
      getConnectSession: async () => ({ session: { session_token: 'tok-1' }, recruiter: null }),
      buildConnectRedirect: async () => 'https://platform.ringcentral.com/restapi/oauth/authorize?state=st8',
      finishConnectCallback: async ({ state }) => {
        if (state !== 'st8') throw new Error('This RingCentral link was not found.');
        return {
          recruiter: { id: 7, name: 'Jane Doe', phone_number: '+15550001111' },
          extension: { name: 'Jane Doe', extensionNumber: '1001' },
          created: true,
          warning: null,
        };
      },
    },
  });

  const redirect = await call(app, 'GET', '/ringcentral/oauth/start?session=tok-1');
  assert.equal(redirect.status, 302);
  assert.match(redirect.location, /platform\.ringcentral\.com\/restapi\/oauth\/authorize/);

  const done = await call(app, 'GET', '/ringcentral/oauth/callback?state=st8&code=abc');
  assert.equal(done.status, 200);
  assert.match(done.text, /RingCentral Connected/);
  assert.match(done.text, /Jane Doe/);
  assert.match(done.text, /\+15550001111/);
  assert.ok(!done.text.includes('abc'), 'the authorization code never appears in the page');

  const cancelled = await call(app, 'GET', '/ringcentral/oauth/callback?error=access_denied&error_description=User%20said%20no');
  assert.equal(cancelled.status, 400);
  assert.match(cancelled.text, /RingCentral Sign-in Failed/);
  assert.match(cancelled.text, /User said no/);

  const forged = await call(app, 'GET', '/ringcentral/oauth/callback?state=forged&code=abc');
  assert.equal(forged.status, 400);
  assert.match(forged.text, /was not found/);
});

test('a wrong-extension sign-in still succeeds, but the page says so', async () => {
  const app = loadApp({
    pool: makePool(),
    connectService: {
      getConnectSession: async () => ({ session: {}, recruiter: null }),
      buildConnectRedirect: async () => 'https://rc.test/authorize',
      finishConnectCallback: async () => ({
        recruiter: { id: 7, name: 'Jane Doe', phone_number: '+15559990000' },
        extension: { name: 'Jane Doe', extensionNumber: '1001' },
        created: false,
        warning: 'This RingCentral user owns +15550001111, not +15559990000.',
      }),
    },
  });
  const res = await call(app, 'GET', '/ringcentral/oauth/callback?state=st8&code=abc');
  assert.equal(res.status, 200);
  assert.match(res.text, /Connected With A Warning/);
  assert.match(res.text, /not \+15559990000/);
});

test('the internal extension list needs the shared secret and returns ids only', async () => {
  const recruiters = [
    { ...JANE, refresh_token_encrypted: 'enc', rc_extension_id: '101' },
    { id: 8, name: 'Bob', phone_number: '+15550002222', jwt_token_encrypted: 'enc', rc_extension_id: '102' },
    { id: 9, name: 'Ada', phone_number: '+15550003333', jwt_token_encrypted: 'enc', rc_extension_id: null },
    { id: 10, name: 'Dup', phone_number: '+15550004444', jwt_token_encrypted: 'enc', rc_extension_id: '101' },
  ];
  const pool = makePool({ recruiters });
  require.cache[POOL_PATH] = { id: POOL_PATH, filename: POOL_PATH, loaded: true, exports: pool };
  purgeDataLayer([INTERNAL_PATH, WEBHOOK_PATH, FB_CONNECT_PATH, LEADS_TG_PATH, MIRROR_PATH]);
  require('../database/ringcentral').invalidateSettingsCache();
  require.cache[WEBHOOK_PATH] = {
    exports: { enqueueVerifiedFacebookPayload: async () => ({}), retryFacebookWebhookEvent: async () => null },
  };
  require.cache[FB_CONNECT_PATH] = { exports: { createConnectSession: async () => ({}) } };
  require.cache[LEADS_TG_PATH] = { exports: { getLeadsTelegram: () => null, sendLeadsMessage: async () => ({}) } };
  require.cache[MIRROR_PATH] = {
    exports: { handleTelegramSmsReply: async () => ({}), registerSmsMirror: async () => ({}) },
  };

  const { createFacebookInternalRoutes } = require(INTERNAL_PATH);
  const app = express();
  app.use(express.json());
  app.use(createFacebookInternalRoutes({
    db: {},
    internalSharedSecretGuard: (req, res, next) => (
      req.headers['x-internal-shared-secret'] === 'internal-secret'
        ? next()
        : res.status(401).json({ error: 'Unauthorized internal request' })
    ),
  }));

  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const denied = await fetch(`${base}/api/internal/ringcentral/sms-extensions`);
    assert.equal(denied.status, 401, 'this list is not public');

    const res = await fetch(`${base}/api/internal/ringcentral/sms-extensions`, {
      headers: { 'x-internal-shared-secret': 'internal-secret' },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { extensions: ['101', '102'] });
    const text = JSON.stringify(body);
    assert.ok(!text.includes('+1555'), 'no phone numbers');
    assert.ok(!text.includes('Jane'), 'no names');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const p of [INTERNAL_PATH, WEBHOOK_PATH, FB_CONNECT_PATH, LEADS_TG_PATH, MIRROR_PATH]) {
      delete require.cache[p];
    }
  }
});
