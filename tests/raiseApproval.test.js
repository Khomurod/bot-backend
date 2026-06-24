const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

// ─── Mock the env-dependent / IO modules before loading the services ───
require.cache[require.resolve('../config/config')] = {
  exports: {
    jwtSecret: 'test-secret',
    employeeGroupId: '-100200300',
    renderExternalUrl: 'https://example.test',
    gmailUser: '',
    gmailAppPassword: '',
  },
};

const sentMessages = [];
require.cache[require.resolve('../bot/bot')] = {
  exports: { bot: { telegram: { sendMessage: async (chatId, text) => { sentMessages.push({ chatId, text }); return { message_id: 1 }; } } } },
};
require.cache[require.resolve('../database/db')] = {
  exports: { claimServiceRun: async () => true, unclaimServiceRun: async () => true },
};
require.cache[require.resolve('../services/ringCentralSmsService')] = {
  exports: { sendSms: async () => ({ ok: true }) },
};
require.cache[require.resolve('../services/datatruckApiService')] = {
  exports: {
    isConfigured: () => true,
    fetchAllDrivers: async () => [
      { id: 1, driver_type: 'company_driver', account: { full_name: 'John Doe' } },
      { id: 2, driver_type: 'company_owner', account: { full_name: 'Owner Olsen' } },
      { id: 3, driver_type: 'company_driver', account: { full_name: 'Jane Roe' } },
    ],
  },
};

// Mutable fake of the raiseApproval DB layer.
const fakeRa = {
  _settings: { otp_channel: 'gmail', rate_low: 0.72, rate_high: 0.75, link_ttl_hours: 48 },
  _team: { id: 7, name: 'Team A', active: true },
  _assigned: [
    { driver_normalized_name: 'JOHN DOE', driver_name: 'John Doe' },
    { driver_normalized_name: 'JANE ROE', driver_name: 'Jane Roe' },
  ],
  _verified: true,
  getRaiseSettings: async () => fakeRa._settings,
  getDispatchTeam: async () => fakeRa._team,
  listTeamDrivers: async () => fakeRa._assigned,
  getRoundByToken: async () => ({
    id: 11, status: 'open', expires_at: DateTime.now().plus({ hours: 5 }).toISO(),
    period_start: '2026-06-15', period_end: '2026-06-21', rate_low: 0.72, rate_high: 0.75,
  }),
  isContactVerified: async () => fakeRa._verified,
  saveSubmissionWithPicks: async () => ({ id: 99 }),
};
require.cache[require.resolve('../database/raiseApproval')] = { exports: fakeRa };

const otp = require('../services/otpService');
const raise = require('../services/raiseApprovalService');

// ─── otpService ───

test('otp code is 6 digits and verifies only with the correct code', () => {
  const code = otp.generateCode();
  assert.match(code, /^\d{6}$/);
  const hash = otp.hashCode(code, 'user@x.com');
  assert.equal(otp.verifyCode(code, 'user@x.com', hash), true);
  assert.equal(otp.verifyCode('000000', 'user@x.com', hash), false);
});

test('normalizePhone adds US country code; channel maps to contact type', () => {
  assert.equal(otp.normalizePhone('(555) 123-4567'), '+15551234567');
  assert.equal(otp.normalizePhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(otp.contactTypeForChannel('ringcentral'), 'phone');
  assert.equal(otp.contactTypeForChannel('gmail'), 'email');
});

// ─── raiseApprovalService ───

test('defaultPreviousWeek returns a Monday→Sunday week that already ended', () => {
  const { periodStart, periodEnd } = raise.defaultPreviousWeek('America/Chicago');
  const start = DateTime.fromISO(periodStart);
  const end = DateTime.fromISO(periodEnd);
  assert.equal(start.weekday, 1, 'start is Monday');
  assert.equal(end.weekday, 7, 'end is Sunday');
  assert.equal(end.diff(start, 'days').days, 6);
  assert.ok(end < DateTime.now(), 'the week has already ended');
});

test('fetchCompanyDriverCandidates returns only company drivers', async () => {
  const drivers = await raise.fetchCompanyDriverCandidates();
  const names = drivers.map((d) => d.driver_name).sort();
  assert.deepEqual(names, ['Jane Roe', 'John Doe']);
});

test('submitResponse rejects an incomplete pick set', async () => {
  await assert.rejects(
    () => raise.submitResponse({
      token: 'tok', teamId: 7, dispatcherName: 'Sam', contact: 'sam@x.com',
      picks: [{ driver_normalized_name: 'JOHN DOE', qualified: true }], // missing Jane
    }),
    /every driver/i
  );
});

test('submitResponse saves and posts a summary to the bonus group', async () => {
  sentMessages.length = 0;
  const result = await raise.submitResponse({
    token: 'tok', teamId: 7, dispatcherName: 'Sam', contact: 'sam@x.com',
    picks: [
      { driver_normalized_name: 'JOHN DOE', qualified: true },
      { driver_normalized_name: 'JANE ROE', qualified: false },
    ],
  });
  assert.equal(result.submitted, true);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Team A/);
  assert.match(sentMessages[0].text, /John Doe/);
});

test('submitResponse refuses when the dispatcher is not verified', async () => {
  fakeRa._verified = false;
  await assert.rejects(
    () => raise.submitResponse({
      token: 'tok', teamId: 7, dispatcherName: 'Sam', contact: 'sam@x.com',
      picks: [
        { driver_normalized_name: 'JOHN DOE', qualified: true },
        { driver_normalized_name: 'JANE ROE', qualified: false },
      ],
    }),
    /verify/i
  );
  fakeRa._verified = true;
});
