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

// The driver-raise workflow has TWO independent admin-configured destinations:
// the REQUEST goes to dispatch, the submitted RESULT goes to accounting. Both are
// mutable here so a test can simulate either being "not configured", and they
// hold DIFFERENT ids by default so a message landing in the wrong one is visible.
const DISPATCH_GROUP = '-100200300';
const ACCOUNTING_GROUP = '-100999888';
const MISSING_MESSAGES = {
  dispatchReview: 'Dispatch rate review group ID is not configured.',
  raiseResults: 'Driver raise results (accounting) group ID is not configured.',
};
const fakeGroups = {
  _groups: { dispatchReview: DISPATCH_GROUP, raiseResults: ACCOUNTING_GROUP },
  async getGroupId(category) {
    if (!(category in fakeGroups._groups)) throw new Error(`Unknown category: ${category}`);
    return fakeGroups._groups[category] || null;
  },
  missingGroupMessage(category) { return MISSING_MESSAGES[category]; },
};
require.cache[require.resolve('../database/messageRoutingSettings')] = { exports: fakeGroups };

/** Reset both destinations to their independent defaults between tests. */
function resetGroups() {
  fakeGroups._groups = { dispatchReview: DISPATCH_GROUP, raiseResults: ACCOUNTING_GROUP };
}

// Mutable fake of the raiseApproval DB layer.
const fakeRa = {
  _rounds: [],
  getOpenRound: async () => null,
  closeRound: async () => null,
  createRound: async (args) => ({ id: 99, ...args }),
  setRoundEmployeeMessage: async () => {},
  _settings: { otp_channel: 'gmail', rate_low: 0.72, rate_high: 0.75, link_ttl_hours: 48 },
  _team: { id: 7, name: 'Team A', active: true },
  _assigned: [
    { driver_normalized_name: 'JOHN DOE', driver_name: 'John Doe' },
    { driver_normalized_name: 'JANE ROE', driver_name: 'Jane Roe' },
  ],
  _verified: true,
  // round_id:team_id -> submission row, simulating the UNIQUE(round_id, team_id) constraint.
  _submissions: new Map(),
  _nextSubmissionId: 1,
  getRaiseSettings: async () => fakeRa._settings,
  getDispatchTeam: async () => fakeRa._team,
  listDispatchTeams: async () => [{ id: fakeRa._team.id, name: fakeRa._team.name }],
  listTeamDrivers: async () => fakeRa._assigned,
  getRoundByToken: async () => ({
    id: 11, status: 'open', expires_at: DateTime.now().plus({ hours: 5 }).toISO(),
    period_start: '2026-06-15', period_end: '2026-06-21', rate_low: 0.72, rate_high: 0.75,
  }),
  isContactVerified: async () => fakeRa._verified,
  getSubmissionForTeam: async (roundId, teamId) => fakeRa._submissions.get(`${roundId}:${teamId}`) || null,
  listSubmittedTeamIds: async (roundId) => [...fakeRa._submissions.values()]
    .filter((s) => s.round_id === roundId)
    .map((s) => s.team_id),
  // Mirrors the real ON CONFLICT DO NOTHING behavior: returns null if a
  // submission already exists for this (round_id, team_id) pair.
  saveSubmissionWithPicks: async ({ roundId, teamId }) => {
    const key = `${roundId}:${teamId}`;
    if (fakeRa._submissions.has(key)) return null;
    const submission = { id: fakeRa._nextSubmissionId++, round_id: roundId, team_id: teamId };
    fakeRa._submissions.set(key, submission);
    return submission;
  },
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

test('submitResponse saves and posts the result ONLY to the accounting group', async () => {
  sentMessages.length = 0;
  fakeRa._submissions.clear();
  resetGroups();
  const result = await raise.submitResponse({
    token: 'tok', teamId: 7, dispatcherName: 'Sam', contact: 'sam@x.com',
    picks: [
      { driver_normalized_name: 'JOHN DOE', qualified: true },
      { driver_normalized_name: 'JANE ROE', qualified: false },
    ],
  });
  assert.equal(result.submitted, true);
  assert.equal(result.results_posted, true);
  assert.equal(result.results_notice, null);
  assert.equal(sentMessages.length, 1, 'exactly one result notification');
  // The result is accounting's, not dispatch's: right group, wrong group untouched.
  assert.equal(sentMessages[0].chatId, ACCOUNTING_GROUP);
  assert.notEqual(sentMessages[0].chatId, DISPATCH_GROUP);
  assert.equal(sentMessages.filter((m) => m.chatId === DISPATCH_GROUP).length, 0,
    'the submitted raise decision must never be posted to the dispatch review group');
  // Still the same useful context: team, submitter, pay period, both rate lists.
  assert.match(sentMessages[0].text, /Team A/);
  assert.match(sentMessages[0].text, /by Sam/);
  assert.match(sentMessages[0].text, /2026-06-15 → 2026-06-21/);
  assert.match(sentMessages[0].text, /Qualify for 75¢\/mile<\/b>\n• John Doe/);
  assert.match(sentMessages[0].text, /Stay at 72¢\/mile<\/b>\n• Jane Roe/);
});

test('a second submitResponse for the same team/round is rejected and sends no further message', async () => {
  sentMessages.length = 0;
  await assert.rejects(
    () => raise.submitResponse({
      token: 'tok', teamId: 7, dispatcherName: 'Someone Else', contact: 'other@x.com',
      picks: [
        { driver_normalized_name: 'JOHN DOE', qualified: false },
        { driver_normalized_name: 'JANE ROE', qualified: true },
      ],
    }),
    /already submitted/i
  );
  assert.equal(sentMessages.length, 0, 'a duplicate submission must not post another message');
});

test('requestOtp refuses to issue a code once the team has already submitted', async () => {
  await assert.rejects(
    () => raise.requestOtp({ token: 'tok', teamId: 7, contact: 'other@x.com' }),
    /already submitted/i
  );
});

test('getPublicRoundInfo marks a team as submitted once it has responded', async () => {
  const info = await raise.getPublicRoundInfo('tok');
  const team = info.teams.find((t) => t.id === 7);
  assert.equal(team.submitted, true);
});

test('submitResponse refuses when the dispatcher is not verified', async () => {
  fakeRa._submissions.clear();
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

// ─── schedule default pay period + configured destination ───

test('defaultPreviousWeek on a Sunday uses the Mon→Sun week ending that same Sunday', () => {
  // Any Sunday (2 PM Central is the default schedule time).
  const sunday = DateTime.fromISO('2026-07-15', { zone: 'America/Chicago' })
    .set({ weekday: 7 }).set({ hour: 14 });
  const { periodStart, periodEnd } = raise.defaultPreviousWeek('America/Chicago', sunday);
  assert.equal(periodEnd, sunday.toISODate(), 'period ends on that same Sunday');
  assert.equal(DateTime.fromISO(periodEnd).weekday, 7, 'end is Sunday');
  assert.equal(DateTime.fromISO(periodStart).weekday, 1, 'start is Monday');
  assert.equal(
    DateTime.fromISO(periodEnd).diff(DateTime.fromISO(periodStart), 'days').days, 6
  );
});

test('the CPM review request is posted ONLY to the configured dispatch review group', async () => {
  sentMessages.length = 0;
  resetGroups();
  const { round, link } = await raise.openRoundAndPost({
    periodStart: '2026-06-29', periodEnd: '2026-07-05', requestedBy: 'test',
  });
  assert.equal(round.id, 99);
  assert.match(link, /\/raise\//);
  assert.equal(sentMessages.length, 1, 'exactly one request message');
  assert.equal(sentMessages[0].chatId, DISPATCH_GROUP);
  assert.equal(sentMessages.filter((m) => m.chatId === ACCOUNTING_GROUP).length, 0,
    'the review request must never reach the accounting results group');
  assert.match(sentMessages[0].text, /Driver Raise Review/);
  assert.match(sentMessages[0].text, /Open the review form/);
});

test('sendNow ("Send now") posts the request ONLY to the dispatch review group', async () => {
  sentMessages.length = 0;
  resetGroups();
  await raise.sendNow({ periodStart: '2026-06-29', periodEnd: '2026-07-05', requestedBy: 'admin' });
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, DISPATCH_GROUP);
  assert.match(sentMessages[0].text, /Driver Raise Review/);
});

test('the scheduled weekly auto-send posts the request ONLY to the dispatch review group', async () => {
  sentMessages.length = 0;
  resetGroups();
  fakeRa._settings = {
    ...fakeRa._settings,
    enabled: true,
    schedule_enabled: true,
    schedule_timezone: 'America/Chicago',
    weekly_day_of_week: 7,
    weekly_time_local: '14:00',
    // Due in the past, so this tick fires.
    next_run_at: DateTime.now().minus({ hours: 1 }).toISO(),
  };
  const patched = [];
  fakeRa.updateRaiseSettings = async (patch) => { patched.push(patch); return fakeRa._settings; };
  await raise.tick();
  assert.equal(sentMessages.length, 1, 'the scheduler sent exactly one request');
  assert.equal(sentMessages[0].chatId, DISPATCH_GROUP);
  assert.equal(sentMessages.filter((m) => m.chatId === ACCOUNTING_GROUP).length, 0,
    'a scheduled review request must never reach the accounting results group');
  assert.ok(patched.length, 'the next run was rescheduled');
  delete fakeRa.updateRaiseSettings;
  fakeRa._settings = { otp_channel: 'gmail', rate_low: 0.72, rate_high: 0.75, link_ttl_hours: 48 };
});

test('openRoundAndPost fails clearly when the dispatch review group is not configured', async () => {
  sentMessages.length = 0;
  resetGroups();
  fakeGroups._groups.dispatchReview = null;
  await assert.rejects(
    () => raise.openRoundAndPost({ periodStart: '2026-06-29', periodEnd: '2026-07-05' }),
    /not configured/i
  );
  assert.equal(sentMessages.length, 0, 'no message sent without a configured group');
  resetGroups();
});

test('a configured accounting group is NOT a fallback for a missing dispatch group', async () => {
  sentMessages.length = 0;
  resetGroups();
  fakeGroups._groups.dispatchReview = null; // accounting stays configured
  await assert.rejects(
    () => raise.openRoundAndPost({ periodStart: '2026-06-29', periodEnd: '2026-07-05' }),
    /Dispatch rate review group ID is not configured/
  );
  assert.equal(sentMessages.length, 0,
    'the review request must not be redirected to the accounting group');
  resetGroups();
});

// ─── Missing accounting destination: the submission must never be lost ───

test('a missing accounting group still saves the submission and sends nothing', async () => {
  sentMessages.length = 0;
  fakeRa._submissions.clear();
  resetGroups();
  fakeGroups._groups.raiseResults = null; // dispatch stays configured

  const result = await raise.submitResponse({
    token: 'tok', teamId: 7, dispatcherName: 'Sam', contact: 'sam@x.com',
    picks: [
      { driver_normalized_name: 'JOHN DOE', qualified: true },
      { driver_normalized_name: 'JANE ROE', qualified: false },
    ],
  });

  // The dispatcher's response is saved and the request does not fail.
  assert.equal(result.submitted, true);
  assert.ok(result.submission_id, 'the submission was persisted');
  assert.equal(fakeRa._submissions.size, 1, 'exactly one stored submission');
  // Reported clearly, not silently swallowed.
  assert.equal(result.results_posted, false);
  assert.equal(result.results_notice, 'RESULTS_GROUP_NOT_CONFIGURED');
  // And NOTHING was sent — least of all to the dispatch review group.
  assert.equal(sentMessages.length, 0, 'no fallback send when accounting is not configured');
  assert.equal(sentMessages.filter((m) => m.chatId === DISPATCH_GROUP).length, 0);
  resetGroups();
});

test('a re-submit after a missing-accounting-group round is still refused (no duplicate)', async () => {
  sentMessages.length = 0;
  resetGroups(); // accounting is configured again — the retry must still be refused
  await assert.rejects(
    () => raise.submitResponse({
      token: 'tok', teamId: 7, dispatcherName: 'Sam', contact: 'sam@x.com',
      picks: [
        { driver_normalized_name: 'JOHN DOE', qualified: true },
        { driver_normalized_name: 'JANE ROE', qualified: false },
      ],
    }),
    /already submitted/i
  );
  assert.equal(fakeRa._submissions.size, 1, 'still exactly one stored submission');
  assert.equal(sentMessages.length, 0, 'a refused retry posts nothing');
});

test('a Telegram failure on the result is reported without losing the submission', async () => {
  sentMessages.length = 0;
  fakeRa._submissions.clear();
  resetGroups();
  const { bot } = require('../bot/bot');
  const realSend = bot.telegram.sendMessage;
  bot.telegram.sendMessage = async () => { throw new Error('Telegram is down'); };
  try {
    const result = await raise.submitResponse({
      token: 'tok', teamId: 7, dispatcherName: 'Sam', contact: 'sam@x.com',
      picks: [
        { driver_normalized_name: 'JOHN DOE', qualified: true },
        { driver_normalized_name: 'JANE ROE', qualified: false },
      ],
    });
    assert.equal(result.submitted, true, 'the submission is saved even when the notify fails');
    assert.equal(result.results_posted, false);
    assert.equal(result.results_notice, 'RESULTS_SEND_FAILED');
    assert.equal(fakeRa._submissions.size, 1);
  } finally {
    bot.telegram.sendMessage = realSend;
  }
});

// The real pg driver returns a SQL DATE column as a JS Date at local midnight,
// not as an ISO string. Interpolating that raw put "Mon Jun 15 2026 00:00:00
// GMT+0000 (Coordinated Universal Time)" in the pay-period line of a payroll
// message. Both destinations must render a plain calendar date either way.
test('the pay period renders as a plain date even when the DB returns Date objects', async () => {
  sentMessages.length = 0;
  fakeRa._submissions.clear();
  resetGroups();
  const realGetRound = fakeRa.getRoundByToken;
  fakeRa.getRoundByToken = async () => ({
    id: 11,
    status: 'open',
    expires_at: DateTime.now().plus({ hours: 5 }).toISO(),
    period_start: new Date(2026, 5, 15), // local midnight, exactly like node-postgres
    period_end: new Date(2026, 5, 21),
    rate_low: 0.72,
    rate_high: 0.75,
  });
  try {
    await raise.submitResponse({
      token: 'tok', teamId: 7, dispatcherName: 'Sam', contact: 'sam@x.com',
      picks: [
        { driver_normalized_name: 'JOHN DOE', qualified: true },
        { driver_normalized_name: 'JANE ROE', qualified: false },
      ],
    });
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].text, /Pay period: 2026-06-15 → 2026-06-21/);
    assert.doesNotMatch(sentMessages[0].text, /GMT|00:00:00|Coordinated/,
      'a raw JS Date must never reach a payroll message');
  } finally {
    fakeRa.getRoundByToken = realGetRound;
  }
});

test('both settings pointing at the same group send the result exactly once', async () => {
  sentMessages.length = 0;
  fakeRa._submissions.clear();
  // An admin may deliberately use one group for both — that is allowed, and must
  // still be ONE message, not a duplicate per destination.
  fakeGroups._groups = { dispatchReview: DISPATCH_GROUP, raiseResults: DISPATCH_GROUP };
  const result = await raise.submitResponse({
    token: 'tok', teamId: 7, dispatcherName: 'Sam', contact: 'sam@x.com',
    picks: [
      { driver_normalized_name: 'JOHN DOE', qualified: true },
      { driver_normalized_name: 'JANE ROE', qualified: false },
    ],
  });
  assert.equal(result.results_posted, true);
  assert.equal(sentMessages.length, 1, 'one submission ⇒ one result message');
  assert.equal(sentMessages[0].chatId, DISPATCH_GROUP);
  resetGroups();
});
