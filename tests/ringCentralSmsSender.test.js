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
 *
 * THE FIXTURES ARE DELIBERATELY UGLY. This suite used to store Jane's number as
 * a perfect `+15550001111`, so it passed while production — where the column
 * holds whatever an admin typed — was rejected on every send with
 * `MSG-245 … Cannot find the phone number which belongs to user`. Every
 * recruiter below is now stored the way a real row reads, and the assertions are
 * on the number that reaches RingCentral.
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
const CALL_PATH = require.resolve('../services/ringCentralCallService');
const SMS_PATH = require.resolve('../services/ringCentralSmsService');

// Stored as typed; `+15550001111` is what must reach RingCentral.
const JANE = { id: 7, name: 'Jane Doe', phone_number: '(555) 000-1111' };

/**
 * `extensionInfo` is what RingCentral says this extension owns. It is read ONLY
 * after a `from` rejection, so `extensionReads` also proves the happy path does
 * not pay for it.
 */
function loadSms({
  token = { accessToken: 'jane-token', apiBase: 'https://rc.test', mode: 'oauth' },
  tokenError = null,
  extensionInfo = null,
  extensionError = null,
} = {}) {
  const extensionReads = [];
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
  require.cache[CALL_PATH] = {
    exports: {
      getExtensionInfoWithToken: async (args) => {
        extensionReads.push(args);
        if (extensionError) throw extensionError;
        return extensionInfo || {};
      },
    },
  };
  delete require.cache[SMS_PATH];
  const sms = require(SMS_PATH);
  const restore = () => {
    delete require.cache[RC_PATH];
    delete require.cache[OAUTH_PATH];
    delete require.cache[CALL_PATH];
    delete require.cache[SMS_PATH];
  };
  return { sms, restore, extensionReads };
}

/** RingCentral's MSG-245 body, as production reports it. */
function fromRejected(attempted) {
  return {
    ok: false,
    status: 400,
    text: async () => JSON.stringify({
      errorCode: 'InvalidParameter',
      message: `Parameter [from] value [${attempted}] is invalid`,
      errors: [{
        errorCode: 'MSG-245',
        message: 'Parameter [from] value is invalid [Cannot find the phone number which belongs to user]',
      }],
    }),
  };
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
    // No id at all is a configuration problem; a row that HAS an id but no
    // usable number is a different one, and they are reported differently.
    for (const row of [null, {}, { phone_number: '+15550001111' }]) {
      const result = await sms.sendSmsAsRecruiter(row, '+1555', 'Hi');
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'recruiter_not_configured');
    }
    for (const row of [{ id: 7 }, { id: 7, phone_number: '  ' }]) {
      const result = await sms.sendSmsAsRecruiter(row, '+1555', 'Hi');
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'recruiter_number_unusable');
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

// ── the production formats, and what actually reaches RingCentral ──

test('every stored spelling sends as E.164 — the MSG-245 regression', async () => {
  // The three recruiters whose sends were rejected in production, as their
  // rows really read. Before the fix each of these strings was handed to
  // RingCentral verbatim and answered with MSG-245.
  const cases = [
    ['(470) 480-4679', '+14704804679'],
    ['(470) 419-4110', '+14704194110'],
    ['4702400064', '+14702400064'],
    ['470-419-4110', '+14704194110'],
    ['+14702400064', '+14702400064'],
  ];

  for (const [stored, expected] of cases) {
    const { sms, restore } = loadSms();
    const fetchSpy = captureFetch({ ok: true, status: 200, json: async () => ({ id: 1 }) });
    try {
      const result = await sms.sendSmsAsRecruiter(
        { id: 7, name: 'Rec', phone_number: stored }, '(555) 999-8888', 'Hi',
      );
      assert.equal(result.ok, true, `${stored} should send`);
      assert.equal(
        fetchSpy.seen[0].body.from.phoneNumber, expected,
        `stored ${stored} must reach RingCentral as ${expected}`,
      );
      // The recipient is normalized on the same rule.
      assert.equal(fetchSpy.seen[0].body.to[0].phoneNumber, '+15559998888');
      assert.equal(result.fromNumber, expected, 'and is reported as what actually sent');
    } finally { fetchSpy.restore(); restore(); }
  }
});

test('a number that cannot be an address is refused without spending a request', async () => {
  const { sms, restore, extensionReads } = loadSms();
  const fetchSpy = captureFetch({ ok: true, json: async () => ({}) });
  try {
    for (const junk of ['not a phone', '470480', '4704804679 x12']) {
      const result = await sms.sendSmsAsRecruiter({ id: 7, name: 'Rec', phone_number: junk }, '+15551112222', 'Hi');
      assert.equal(result.ok, false);
      // NOT `recruiter_not_configured`: this recruiter's credentials are fine,
      // and telling an operator to re-connect a working login wastes their time.
      assert.equal(result.reason, 'recruiter_number_unusable');
      assert.match(result.detail, /is not a phone number this can send from/);
    }
    assert.equal(fetchSpy.seen.length, 0, 'no send is attempted');
    assert.equal(extensionReads.length, 0, 'and no extension read either');
  } finally { fetchSpy.restore(); restore(); }
});

test('the happy path never reads the extension', async () => {
  // The verify step is only worth its request after a rejection.
  const { sms, restore, extensionReads } = loadSms();
  const fetchSpy = captureFetch({ ok: true, status: 200, json: async () => ({ id: 5 }) });
  try {
    const result = await sms.sendSmsAsRecruiter(JANE, '+15559998888', 'Hi');
    assert.equal(result.ok, true);
    assert.equal(extensionReads.length, 0);
  } finally { fetchSpy.restore(); restore(); }
});

// ── a `from` rejection is checked against what the extension owns ──

test('RingCentral spelling the number differently is retried once, and reported', async () => {
  // The realistic case: an admin typed a stray country code, so the stored
  // number normalizes to a valid-looking address that RingCentral does not
  // have — but its last ten digits are the recruiter's real line. Sending it
  // RingCentral's way is strictly better than falling back to the shared
  // number the driver has never seen.
  const WRONG_CC = { id: 7, name: 'Jane Doe', phone_number: '+44 (555) 000-1111' };
  const { sms, restore, extensionReads } = loadSms({
    extensionInfo: {
      extensionId: '80055512',
      phoneNumberDetails: [
        { phoneNumber: '+15550001111', usageType: 'DirectNumber', features: ['SmsSender', 'CallerId'] },
      ],
      smsNumber: '+15550001111',
    },
  });
  let call = 0;
  const fetchSpy = captureFetch(() => {
    call += 1;
    return call === 1
      ? fromRejected('+445550001111')
      : { ok: true, status: 200, json: async () => ({ id: 42, conversationId: 9 }) };
  });
  try {
    const result = await sms.sendSmsAsRecruiter(WRONG_CC, '+15559998888', 'Hi');
    assert.equal(fetchSpy.seen[0].body.from.phoneNumber, '+445550001111', 'the stored number was tried first');
    assert.equal(result.ok, true, 'the retry succeeds');
    assert.equal(result.messageId, '42');
    assert.equal(result.correctedFrom, '+15550001111', 'the correction is reported');
    assert.equal(result.extensionId, '80055512', 'and so is the extension identity');
    assert.equal(extensionReads.length, 1, 'the extension is read exactly once');
    assert.equal(fetchSpy.seen.length, 2, 'and the message is retried exactly once');
    assert.equal(fetchSpy.seen[1].body.from.phoneNumber, '+15550001111');
  } finally { fetchSpy.restore(); restore(); }
});

test('a number the extension does not own is named as such, not left as MSG-245', async () => {
  // The real "wrong number configured" case: an operator typed a line that
  // belongs to somebody else. The lead must fall back, and the reason must say
  // what to fix.
  const { sms, restore } = loadSms({
    extensionInfo: {
      extensionId: '80055512',
      phoneNumberDetails: [
        { phoneNumber: '+15557779999', usageType: 'DirectNumber', features: ['SmsSender'] },
      ],
      smsNumber: '+15557779999',
    },
  });
  const fetchSpy = captureFetch(fromRejected('(555) 000-1111'));
  try {
    const result = await sms.sendSmsAsRecruiter(JANE, '+15559998888', 'Hi');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'recruiter_number_not_on_extension');
    assert.equal(result.attemptedFrom, '+15550001111');
    assert.equal(result.extensionSmsNumber, '+15557779999', 'what they could send from');
    assert.match(result.detail, /MSG-245/, 'the provider body is kept for the operator');
    assert.equal(fetchSpy.seen.length, 1, 'no blind retry');
  } finally { fetchSpy.restore(); restore(); }
});

test('a number on the extension that cannot text is reported distinctly', async () => {
  // Present, but no SmsSender feature — an unregistered A2P/10DLC line looks
  // exactly like this, and it is a different thing to fix.
  const { sms, restore } = loadSms({
    extensionInfo: {
      extensionId: '80055512',
      phoneNumberDetails: [
        { phoneNumber: '+15550001111', usageType: 'DirectNumber', features: ['CallerId'] },
      ],
      smsNumber: null,
    },
  });
  const fetchSpy = captureFetch(fromRejected('(555) 000-1111'));
  try {
    const result = await sms.sendSmsAsRecruiter(JANE, '+15559998888', 'Hi');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'recruiter_number_not_sms_capable');
    assert.equal(fetchSpy.seen.length, 1);
  } finally { fetchSpy.restore(); restore(); }
});

test('losing the extension read changes how well we describe it, not the outcome', async () => {
  const { sms, restore } = loadSms({ extensionError: new Error('403 forbidden') });
  const fetchSpy = captureFetch(fromRejected('(555) 000-1111'));
  try {
    const result = await sms.sendSmsAsRecruiter(JANE, '+15559998888', 'Hi');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'recruiter_send_failed', 'still a send failure the caller falls back on');
    assert.equal(result.inspectError, '403 forbidden');
    assert.match(result.detail, /MSG-245/);
  } finally { fetchSpy.restore(); restore(); }
});

test('a rejection that is NOT about `from` is left alone', async () => {
  // An unregistered campaign, a blocked recipient — nothing to learn from the
  // extension, and a wasted request if we asked.
  const { sms, restore, extensionReads } = loadSms();
  const fetchSpy = captureFetch({ ok: false, status: 400, text: async () => 'Number not registered for SMS' });
  try {
    const result = await sms.sendSmsAsRecruiter(JANE, '+15559998888', 'Hi');
    assert.equal(result.reason, 'http_400', 'the original reason survives');
    assert.equal(extensionReads.length, 0, 'and the extension is not consulted');
  } finally { fetchSpy.restore(); restore(); }
});
