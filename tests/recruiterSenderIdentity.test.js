/**
 * The recruiter row as a SENDER IDENTITY: which credential wins, whether the
 * row can send at all, and how a Bitrix user id is normalized.
 *
 * These are the predicates the whole feature branches on. `canSendSms` decides
 * whether a lead assigned to someone is texted from their number or from the
 * shared one, and `mode` decides which credential is used to do it — so both
 * are pinned here against the real encrypted-column shapes rather than trusted
 * to read correctly.
 *
 * Pure functions only: no database, no network. The rows are the shapes
 * PostgreSQL actually returns.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

const { encryptText } = require('../lib/security/facebookCrypto');
const rc = require('../database/ringcentral');
// toAdminRecruiter is deliberately NOT on the façade (see database/ringcentral.js
// — it is a sibling helper, not public API), so it is required from its module.
const { toAdminRecruiter } = require('../database/ringcentral/recruiters');

const CFG = { apiBase: 'https://rc.test', clientId: 'shared-id', clientSecret: 'shared-secret' };

const row = (extra = {}) => ({
  id: 7,
  name: 'Jane Doe',
  phone_number: '+15550001111',
  active: true,
  ...extra,
});

test('a RingCentral login outranks a pasted JWT', () => {
  // Both stored: the login is preferred because it is the one that rotates and
  // that nobody had to handle by hand.
  const auth = rc.resolveRecruiterRcAuth(
    row({ refresh_token_encrypted: encryptText('refresh-1'), jwt_token_encrypted: encryptText('jwt-1') }),
    CFG,
  );
  assert.equal(auth.mode, 'oauth');
  assert.equal(auth.refreshToken, 'refresh-1');
  assert.equal(auth.jwtToken, 'jwt-1', 'the JWT is still resolved, just not chosen');
});

test('with only a JWT the mode is jwt; with neither it is none', () => {
  assert.equal(rc.resolveRecruiterRcAuth(row({ jwt_token_encrypted: encryptText('jwt-1') }), CFG).mode, 'jwt');
  assert.equal(rc.resolveRecruiterRcAuth(row(), CFG).mode, 'none');
  assert.equal(rc.resolveRecruiterRcAuth(null, CFG).mode, 'none');
});

test('the shared app credentials are used unless the row overrides them', () => {
  const shared = rc.resolveRecruiterRcAuth(row({ jwt_token_encrypted: encryptText('j') }), CFG);
  assert.deepEqual(
    { id: shared.clientId, secret: shared.clientSecret, custom: shared.usesCustomClient },
    { id: 'shared-id', secret: 'shared-secret', custom: false },
  );

  const own = rc.resolveRecruiterRcAuth(
    row({
      jwt_token_encrypted: encryptText('j'),
      client_id_encrypted: encryptText('own-id'),
      client_secret_encrypted: encryptText('own-secret'),
    }),
    CFG,
  );
  assert.deepEqual(
    { id: own.clientId, secret: own.clientSecret, custom: own.usesCustomClient },
    { id: 'own-id', secret: 'own-secret', custom: true },
  );
});

test('the resolved auth carries the identity a send needs', () => {
  const auth = rc.resolveRecruiterRcAuth(
    row({ refresh_token_encrypted: encryptText('r'), rc_extension_id: '101' }),
    CFG,
  );
  // fromNumber and extensionId are what make the send and the inbound
  // subscription target the right person.
  assert.equal(auth.recruiterId, 7);
  assert.equal(auth.fromNumber, '+15550001111');
  assert.equal(auth.extensionId, '101');
  assert.equal(auth.apiBase, 'https://rc.test');
});

test('canSendSms needs BOTH a credential and a number to send from', () => {
  assert.equal(rc.recruiterCanSendSms(row({ refresh_token_encrypted: encryptText('r') })), true);
  assert.equal(rc.recruiterCanSendSms(row({ jwt_token_encrypted: encryptText('j') })), true);
  assert.equal(rc.recruiterCanSendSms(row()), false, 'no credential');
  assert.equal(
    rc.recruiterCanSendSms({ ...row({ refresh_token_encrypted: encryptText('r') }), phone_number: null }),
    false,
    'a credential with no number cannot be a sender',
  );
  assert.equal(rc.recruiterCanSendSms(null), false);
});

test('a corrupted secret reads as "cannot send" rather than throwing at a lead', () => {
  // A key rotation or a truncated column must degrade to the shared number,
  // not blow up in the middle of processing a lead.
  const broken = row({ refresh_token_encrypted: 'not-a-valid-envelope' });
  assert.equal(rc.recruiterCanSendSms(broken), false);
  assert.equal(rc.resolveRecruiterRcAuth(broken, CFG).mode, 'none');
});

test('a Bitrix user id is a positive integer, or nothing', () => {
  assert.equal(rc.normalizeBitrixUserId(17), 17);
  assert.equal(rc.normalizeBitrixUserId('17'), 17, 'the admin form sends a string');
  assert.equal(rc.normalizeBitrixUserId(' 17 '), 17);
  for (const blank of [null, undefined, '']) {
    assert.equal(rc.normalizeBitrixUserId(blank), null, `clearing with ${JSON.stringify(blank)}`);
  }
  for (const junk of ['Tom Robinson', 0, -3, 'abc', {}]) {
    assert.equal(rc.normalizeBitrixUserId(junk), null, `junk: ${JSON.stringify(junk)}`);
  }
});

test('the admin view reports the sender state and never a secret', () => {
  const admin = toAdminRecruiter(row({
    bitrix_user_id: 17,
    refresh_token_encrypted: encryptText('refresh-secret-value'),
    rc_extension_id: '101',
    rc_extension_number: '1001',
    rc_auth_error: null,
  }));
  assert.deepEqual(
    {
      mode: admin.authMode,
      canSend: admin.canSendSms,
      oauth: admin.oauthConnected,
      bitrix: admin.bitrixUserId,
      ext: admin.rcExtensionNumber,
    },
    { mode: 'oauth', canSend: true, oauth: true, bitrix: 17, ext: '1001' },
  );
  const serialized = JSON.stringify(admin);
  assert.ok(!serialized.includes('refresh-secret-value'), 'a refresh token must never reach the browser');
  assert.ok(!('refresh_token_encrypted' in admin));
  assert.ok(!('refreshToken' in admin));
});

test('a recruiter needing a new sign-in is visible as such in the admin view', () => {
  const admin = toAdminRecruiter(row({
    refresh_token_encrypted: encryptText('r'),
    rc_auth_error: 'RingCentral login expired — this recruiter must connect RingCentral again.',
  }));
  assert.match(admin.rcAuthError, /connect RingCentral again/);
  // Still "canSendSms": the credential exists, it just needs renewing. The
  // error is what the panel renders; the sender falls back on the next failure.
  assert.equal(admin.canSendSms, true);
});

test('the ringcentral façade exposes the sender helpers routes and services import', () => {
  for (const key of [
    'recruiterCanSendSms', 'hasMappedSmsSenders', 'getRecruiterByBitrixUserId',
    'storeRecruiterOAuthTokens', 'updateRecruiterRefreshToken', 'markRecruiterAuthError',
    'clearRecruiterOAuth', 'listRecruitersWithOwnCredentials', 'createRcConnectSession',
    'getRcConnectSessionByToken', 'getRcConnectSessionByOAuthState',
    'setRcConnectSessionOAuthState', 'completeRcConnectSession',
    'markRcConnectSessionError', 'expireOldRcConnectSessions',
  ]) {
    assert.equal(typeof rc[key], 'function', `database/ringcentral must export ${key}`);
  }
});
