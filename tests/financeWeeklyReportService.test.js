'use strict';

/**
 * Once a period, or not at all.
 *
 * THE FAILURE THIS EXISTS TO PREVENT is two identical reports in one morning.
 * A redeploy on a Monday restarts every timer in this application, and a weekly
 * job whose only guard is "have I run since I started?" sends again — to a room
 * of people who will reasonably read the second one as meaning something.
 *
 * AND THE MIRROR OF IT: a claim held after a failed send is a report that never
 * arrives and never retries, because the job believes forever that it handled
 * that week. This application has lost birthday wishes to exactly that, which
 * is why `unclaimServiceRun` is asserted here rather than assumed.
 *
 * A BACKFILL IS RECORDED AND NOT SENT, and the claim is KEPT — the period IS
 * handled; it simply has no honest report. Sending "$0 issued" for a week
 * nobody was watching is the one wrong answer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const R = (rel) => path.resolve(ROOT, rel);
function stub(rel, exports) {
  const filename = require.resolve(R(rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// ── stub state ────────────────────────────────────────────────────────────
let settings;
/** Set to make the settings read fail, the way a database outage does. */
let settingsError = null;
let claims;              // run keys already claimed
let unclaimed;           // run keys released
let recorded;            // finance_reports rows written
let sends;               // telegram sendMessage calls
let sendError = null;
let totals;
let totalsError = null;
let notices;

stub('database/db.js', {
  claimServiceRun: async (service, key) => {
    if (claims.has(`${service}:${key}`)) return false;
    claims.add(`${service}:${key}`);
    return true;
  },
  unclaimServiceRun: async (service, key) => {
    unclaimed.push(key);
    return claims.delete(`${service}:${key}`);
  },
  query: async () => ({ rows: [] }),
});
stub('database/financeSettings.js', {
  getFinanceSettings: async () => {
    if (settingsError) throw settingsError;
    return settings;
  },
  isFinanceChat: async () => true,
  invalidateCache: () => {},
});
stub('database/finance/reports.js', {
  summariseFinancePeriod: async () => {
    if (totalsError) throw totalsError;
    return totals;
  },
  recordReport: async (fields) => { recorded.push(fields); return { id: recorded.length, created: true }; },
  findReportForPeriod: async () => null,
  listReports: async () => [],
});
stub('services/operations/runLedger.js', { withRunRecord: async (key, pass) => pass() });
stub('services/telegramHtml.js', { safeSend: async (fn) => fn() });
stub('services/notifications/send.js', {
  notify: async (n) => { notices.push(n); return { recorded: true, delivered: true }; },
});

const service = require(R('services/finance/weeklyReportService'));
const schedule = require(R('lib/finance/schedule'));

const MONDAY_AFTER = '2026-09-07T14:00:00Z';   // Monday, an hour past the send
const WEDNESDAY = '2026-09-09T12:00:00Z';

const telegram = {
  sendMessage: async (chatId, body, opts) => {
    if (sendError) throw sendError;
    sends.push({ chatId, body, opts });
    return { message_id: 900 + sends.length };
  },
};

function reset(over = {}) {
  claims = new Set(); unclaimed = []; recorded = []; sends = []; notices = [];
  sendError = null; totalsError = null; settingsError = null;
  totals = { codeCount: 3, amountTotal: 900, messageCount: 20 };
  settings = {
    enabled: true, chatId: '-100finance', weeklyReportEnabled: true,
    weeklyReportChatId: null, enabledAt: '2026-01-01T00:00:00Z', ...over,
  };
}

const at = (iso) => ({ telegram, now: () => new Date(iso) });

// ── the tests ─────────────────────────────────────────────────────────────

test('it sends once, and records what it sent', async () => {
  reset();
  const out = await service.runWeeklyReport(at(WEDNESDAY));

  assert.equal(out.sent, 1);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].chatId, '-100finance');
  assert.equal(sends[0].opts.parse_mode, 'HTML');

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].status, 'sent');
  assert.equal(recorded[0].telegramMessageId, 901);
  assert.deepEqual(recorded[0].totals, totals);
  assert.ok(recorded[0].body.includes('3 codes'), 'the SENT text is stored, not recomputed later');
});

test('A SECOND TICK IN THE SAME WEEK SENDS NOTHING — the redeploy case', async () => {
  reset();
  await service.runWeeklyReport(at(MONDAY_AFTER));
  assert.equal(sends.length, 1);

  // The application restarts; the timer fires again minutes later.
  const second = await service.runWeeklyReport(at('2026-09-07T14:05:00Z'));
  assert.match(second.skipped, /already been reported/);
  assert.equal(sends.length, 1, 'two reports in one morning is the failure this prevents');
  assert.equal(recorded.length, 1);

  // And still nothing later in the same week.
  await service.runWeeklyReport(at(WEDNESDAY));
  assert.equal(sends.length, 1);
});

test('the next week is a different claim, so it does send', async () => {
  reset();
  await service.runWeeklyReport(at(WEDNESDAY));
  await service.runWeeklyReport(at('2026-09-16T12:00:00Z'));
  assert.equal(sends.length, 2);
  assert.notEqual(recorded[0].periodStart.getTime(), recorded[1].periodStart.getTime());
});

test('A FAILED SEND RELEASES THE CLAIM, so it is retried rather than lost', async () => {
  reset();
  sendError = new Error('Bad Request: chat not found');

  const out = await service.runWeeklyReport(at(WEDNESDAY));
  assert.equal(out.retry, true);
  assert.match(out.error, /chat not found/);

  const key = schedule.runKeyFor(schedule.periodFor(schedule.mostRecentScheduledRun(WEDNESDAY)).periodStart);
  assert.deepEqual(unclaimed, [key], 'without this the job believes forever that it handled the week');
  assert.equal(recorded[0].status, 'failed');
  assert.equal(notices.length, 1, 'and somebody is told');
  assert.equal(notices[0].category, 'finance');

  // The retry then works.
  sendError = null;
  const retry = await service.runWeeklyReport(at(WEDNESDAY));
  assert.equal(retry.sent, 1);
  assert.equal(sends.length, 1);
});

test('a failure to COUNT also releases the claim, and records nothing', async () => {
  reset();
  totalsError = new Error('connection refused');

  const out = await service.runWeeklyReport(at(WEDNESDAY));
  assert.match(out.error, /connection refused/);
  assert.equal(unclaimed.length, 1);
  assert.equal(recorded.length, 0, 'a report nobody could count is not a report that failed to send');
  assert.equal(sends.length, 0);
});

test('a backfill is recorded and NOT sent, and the claim is kept', async () => {
  reset({ enabledAt: '2026-09-04T00:00:00Z' }); // switched on midway through

  const out = await service.runWeeklyReport(at(WEDNESDAY));
  assert.match(out.skipped, /predates/);
  assert.equal(sends.length, 0, '"$0 issued" for a week nobody watched is the one wrong answer');
  assert.equal(recorded[0].status, 'suppressed_backfill');
  assert.equal(recorded[0].totals, null);
  assert.equal(unclaimed.length, 0, 'the period IS handled — it simply has no honest report');

  // And it does not come back round.
  const again = await service.runWeeklyReport(at(WEDNESDAY));
  assert.match(again.skipped, /already been reported/);
});

test('it stands down — blocked, not failed — when switched off or unconfigured', async () => {
  reset({ enabled: false });
  assert.match((await service.runWeeklyReport(at(WEDNESDAY))).blocked, /switched off/);

  reset({ weeklyReportEnabled: false });
  assert.match((await service.runWeeklyReport(at(WEDNESDAY))).blocked, /switched off/);

  reset({ chatId: null, weeklyReportChatId: null });
  assert.match((await service.runWeeklyReport(at(WEDNESDAY))).blocked, /no chat is configured/);

  reset();
  assert.match((await service.runWeeklyReport({ now: () => new Date(WEDNESDAY) })).blocked, /Telegram client/);

  assert.equal(sends.length, 0);
  assert.equal(claims.size, 0, 'a stand-down must not consume the week\'s claim');
});

test('a dedicated report chat wins over the finance group', async () => {
  reset({ weeklyReportChatId: '-100accounting' });
  await service.runWeeklyReport(at(WEDNESDAY));
  assert.equal(sends[0].chatId, '-100accounting');
});

test('IT HANDLES ONE WEEK PER TICK, never a loop over missed weeks', async () => {
  reset();
  // The application was down for a month and comes back up.
  const out = await service.runWeeklyReport(at('2026-10-07T12:00:00Z'));
  assert.equal(out.sent, 1);
  assert.equal(sends.length, 1, 'four reports in four seconds is not a catch-up, it is a burst');
});

test('a settings failure is an error, not "switched off"', async () => {
  reset();
  settingsError = new Error('pool is gone');
  const out = await service.runWeeklyReport(at(WEDNESDAY));
  assert.match(out.error, /pool is gone/);
  assert.equal(out.blocked, undefined, 'an outage and an off switch are opposite answers');
});

test('the tick never throws, and always reports when it is next due', async () => {
  reset();
  const out = await service.tick(at(WEDNESDAY));
  assert.equal(out.retry, false);
  assert.ok(out.dueAtMs > new Date(WEDNESDAY).getTime());
  assert.equal(new Date(out.dueAtMs).toISOString(), schedule.nextScheduledRun(WEDNESDAY).toISOString());
});
