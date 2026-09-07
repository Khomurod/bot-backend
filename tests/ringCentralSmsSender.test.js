/**
 * sendSmsAsRecruiter — the HTTP call that makes a text come from the right
 * person.
 *
 * RingCentral rejects an SMS whose `from` is not a number on the extension the
 * token belongs to, so two things must be true together on every send: the
 * token is that recruiter's, and `from` is that recruiter's number. A mismatch
 * would authenticate fine and then fail (or worse, send as someone else), so
 * both are asserted from the request that actually goes out.
 *
 * The shared-number sender is asserted too — it is the fallback the whole lead
 * flow leans on, and it must keep behaving exactly as it did before.
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
const SMS_PATH = require.resolve('../services/ringCentralSmsService');

const JANE = { id: 7, name: 'Jane Doe', phone_number: '+15550001111' };

function loadSms({ token = { accessToken: 'jane-token', apiBase: 'https://rc.test', mode: 'oauth' }, tokenError = null } = {}) {
  require.cache[RC_PATH] = {
    exports: { getRcConfig: async () => ({ apiBase: 'https://rc.test', clientId: 'cid', clientSecret: 'sec' }) },
  };
  require.cache[OAUTH_PATH] = {
    exports: {
      getRecruiterAccessToken: async () => {
        if (tokenError) throw tokenError;
        return token;
      },
    },
  };
  delete require.cache[SMS_PATH];
  const sms = require(SMS_PATH);
  const restore = () => {
    delete require.cache[RC_PATH];
    delete require.cache[OAUTH_PATH];
    delete require.cache[SMS_PATH];
  };
  return { sms, restore };
}

/** Capture the outgoing request and answer it. */
function captureFetch(response) {
  const seen = [];
  const original = global.fetch;
  global.fetch = async (url, options) => {
    seen.push({ url: String(url), options, body: options?.body ? JSON.parse(options.body) : null });
    return typeof response === 'function' ? response() : response;
  };
  return { seen, restore: () => { global.fetch = original; } };
}

test('the recruiter send uses THEIR token and THEIR number', async () => {
  const { sms, restore } = loadSms();
  const fetchSpy = captureFetch({
    ok: true,
    status: 200,
    json: async () => ({ id: 987, conversationId: 654 }),
  });
  try {
    const result = await sms.sendSmsAsRecruiter(JANE, '+15559998888', 'Hi Alex');
    assert.deepEqual(
      { ok: result.ok, from: result.fromNumber, id: result.messageId, conv: result.conversationId, mode: result.authMode, rid: result.recruiterId },
      { ok: true, from: '+15550001111', id: '987', conv: '654', mode: 'oauth', rid: 7 },
    );

    assert.equal(fetchSpy.seen.length, 1);
    const [call] = fetchSpy.seen;
    // ~/~ on purpose: the extension is whoever the token belongs to.
    assert.equal(call.url, 'https://rc.test/restapi/v1.0/account/~/extension/~/sms');
    assert.equal(call.options.headers.Authorization, 'Bearer jane-token');
    assert.deepEqual(call.body, {
      from: { phoneNumber: '+15550001111' },
      to: [{ phoneNumber: '+15559998888' }],
      text: 'Hi Alex',
    });
  } finally { fetchSpy.restore(); restore(); }
});

test('a recruiter with no credentials is reported as such, with no request sent', async () => {
  const err = new Error('Jane Doe has no RingCentral credentials of their own.');
  err.code = 'RC_NO_RECRUITER_CREDENTIALS';
  const { sms, restore } = loadSms({ tokenError: err });
  const fetchSpy = captureFetch({ ok: true, json: async () => ({}) });
  try {
    const result = await sms.sendSmsAsRecruiter(JANE, '+1555', 'Hi');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'recruiter_not_configured');
    assert.equal(result.recruiterId, 7);
    assert.equal(fetchSpy.seen.length, 0);
  } finally { fetchSpy.restore(); restore(); }
});

test('an expired login is reported as an auth failure, distinctly from a rejection', async () => {
  const err = new Error('RingCentral OAuth failed (400): invalid_grant');
  err.code = 'RC_REFRESH_EXPIRED';
  const { sms, restore } = loadSms({ tokenError: err });
  try {
    const result = await sms.sendSmsAsRecruiter(JANE, '+1555', 'Hi');
    assert.equal(result.reason, 'recruiter_auth_failed');
    assert.equal(result.code, 'RC_REFRESH_EXPIRED');
    assert.match(result.detail, /invalid_grant/);
  } finally { restore(); }
});

test('RingCentral rejecting the message reports the status and body, not a throw', async () => {
  const { sms, restore } = loadSms();
  const fetchSpy = captureFetch({
    ok: false,
    status: 400,
    text: async () => 'Number not registered for SMS',
  });
  try {
    const result = await sms.sendSmsAsRecruiter(JANE, '+1555', 'Hi');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'http_400');
    assert.match(result.detail, /not registered/i);
    assert.equal(result.fromNumber, '+15550001111');
  } finally { fetchSpy.restore(); restore(); }
});

test('a recruiter row with no id or no number never reaches RingCentral', async () => {
  const { sms, restore } = loadSms();
  const fetchSpy = captureFetch({ ok: true, json: async () => ({}) });
  try {
    for (const row of [null, {}, { id: 7 }, { id: 7, phone_number: '  ' }, { phone_number: '+1555' }]) {
      const result = await sms.sendSmsAsRecruiter(row, '+1555', 'Hi');
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'recruiter_not_configured');
    }
    assert.equal(fetchSpy.seen.length, 0);
  } finally { fetchSpy.restore(); restore(); }
});

test('a JWT-credentialed recruiter takes the same path, reported as jwt', async () => {
  const { sms, restore } = loadSms({
    token: { accessToken: 'jwt-token', apiBase: 'https://rc.test', mode: 'jwt' },
  });
  const fetchSpy = captureFetch({ ok: true, status: 200, json: async () => ({ id: 1 }) });
  try {
    const result = await sms.sendSmsAsRecruiter(JANE, '+1555', 'Hi');
    assert.equal(result.ok, true);
    assert.equal(result.authMode, 'jwt');
    assert.equal(fetchSpy.seen[0].options.headers.Authorization, 'Bearer jwt-token');
  } finally { fetchSpy.restore(); restore(); }
});

test('the shared-number sender still sends from RC_FROM_NUMBER, unchanged', async () => {
  const saved = {
    id: process.env.RC_CLIENT_ID,
    secret: process.env.RC_CLIENT_SECRET,
    jwt: process.env.RC_JWT_TOKEN,
    from: process.env.RC_FROM_NUMBER,
  };
  process.env.RC_CLIENT_ID = 'cid';
  process.env.RC_CLIENT_SECRET = 'sec';
  process.env.RC_JWT_TOKEN = 'shared-jwt';
  process.env.RC_FROM_NUMBER = '+14704804679';
  const { sms, restore } = loadSms();
  const original = global.fetch;
  const seen = [];
  global.fetch = async (url, options) => {
    const href = String(url);
    seen.push(href);
    if (href.includes('/oauth/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'shared-token', expires_in: 3600 }) };
    }
    seen.push(JSON.parse(options.body).from.phoneNumber);
    return { ok: true, status: 200, json: async () => ({ id: 5 }) };
  };
  try {
    const result = await sms.sendSms('+15559998888', 'Hi');
    assert.equal(result.ok, true);
    assert.equal(result.messageId, '5');
    assert.ok(seen.includes('+14704804679'), 'from must be the shared company number');
    assert.ok(seen.some((s) => s.startsWith('https://platform.ringcentral.com/restapi/v1.0/')));
  } finally {
    global.fetch = original;
    restore();
    for (const [key, value] of Object.entries({
      RC_CLIENT_ID: saved.id, RC_CLIENT_SECRET: saved.secret,
      RC_JWT_TOKEN: saved.jwt, RC_FROM_NUMBER: saved.from,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('the shared sender reports not_configured instead of half-sending', async () => {
  const saved = process.env.RC_CLIENT_ID;
  delete process.env.RC_CLIENT_ID;
  const { sms, restore } = loadSms();
  const fetchSpy = captureFetch({ ok: true, json: async () => ({}) });
  try {
    const result = await sms.sendSms('+1555', 'Hi');
    assert.deepEqual(result, { ok: false, reason: 'not_configured' });
    assert.equal(fetchSpy.seen.length, 0);
  } finally {
    fetchSpy.restore();
    restore();
    if (saved === undefined) delete process.env.RC_CLIENT_ID;
    else process.env.RC_CLIENT_ID = saved;
  }
});
