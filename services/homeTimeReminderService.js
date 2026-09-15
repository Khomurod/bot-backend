/**
 * Home-Time housekeeping ticker.
 *
 * WHAT THIS USED TO BE. A reminder service: when a driver had not supplied a
 * missing home-time date, the bot sent two reminders twelve hours apart and then
 * flagged the request `clarification_unanswered`. All of that is gone. It chased
 * two PLANNED dates — a guess about next week, typed by somebody about to drive
 * home — and the dates that are actually recorded as Home In and Home Out come
 * from the Dispatcher Board and the driver's own status, never from a plan. A
 * driver who does not answer a question about next Tuesday has done nothing
 * wrong, and Wenze no longer asks.
 *
 * WHAT IT IS NOW. One cleanup sweep with no audience: a request whose window has
 * passed is CLOSED so it stops blocking the next one, and nobody is told. The
 * count reaches the run ledger so the worker's health is legible; it is not a
 * notice, because the calendar advancing is not an operational problem.
 *
 * Two STAFF-facing retries ride this ticker as separate responsibilities: the
 * internal clarification alert, and the manager notices for the three home-time
 * events. Both are attempted inline when they happen; this is only the retry.
 *
 * The name is kept because `startHomeTimeReminderService` is imported by
 * services/backgroundServices.js and a rename buys nothing; this header is the
 * record of what it stopped being.
 */
const { DateTime } = require('luxon');
const ht = require('../database/homeTime');
const { callGeminiText } = require('./geminiClient');
const { buildDriverMention } = require('./driverMention');
const { isDriverMessagingEnabled, sendToDriverGroup } = require('./homeTimeDriverChannel');
const { withRunRecord, noteHeartbeat } = require('./operations/runLedger');

const POLL_MS = 5 * 60 * 1000; // 5 min — reminders are hours apart, so this is ample
const FIRST_TICK_DELAY_MS = 30 * 1000;

let serviceTimer = null;
let serviceStopped = false;
let tickRunning = false;
let telegramClient = null;

/*
 * runHomeTimeReminderCheck lived here.
 *
 * It chased drivers for the two PLANNED dates of a home-time request: a first
 * reminder after twelve hours, a second after twelve more, and then the request
 * was marked unanswered. Every part of that was work in service of a guess —
 * the planned dates were never what Home In and Home Out are recorded from, and
 * a driver who does not answer a question about next week has not done anything
 * wrong.
 *
 * A request is now recorded and delivered and finished, so there is nothing
 * left to remind anybody about. What remains on this timer is the cleanup sweep
 * below, which closes requests whose window has passed so they stop blocking the
 * next one, and tells nobody.
 *
 * `next_reminder_at` is left in the schema and is simply never set: the column
 * still carries what was scheduled for rows that predate this, which is history
 * rather than a queue.
 */

/**
 * Close outdated home-time requests (dates passed / stale clarification),
 * updating any Telegram card. Runs on the same restart-safe cadence as the
 * reminder sweep and is gated on the feature being enabled. The closing logic is
 * required lazily so this module can be unit-tested (and the reminder tests
 * loaded) without pulling in config/bot at require time.
 *
 * NOBODY IS TOLD. The count goes to the run ledger so the worker's health is
 * legible; it is not a notice, because "the dates a driver asked for have gone
 * by" is a calendar fact, not an operational problem.
 *
 * @returns {{ enabled:boolean, scanned:number, closed:number }}
 */
async function runHomeTimeCleanupSweep(telegram, { nowIso } = {}) {
  const settings = await ht.getHomeTimeSettings();
  if (!settings || !settings.enabled) return { enabled: false, scanned: 0, closed: 0 };
  const { sweepOutdatedHomeTimeRequests } = require('./homeTimeApproval');
  const todayIso = (nowIso ? DateTime.fromISO(nowIso) : DateTime.now())
    .setZone('America/Chicago').toISODate();
  const result = await sweepOutdatedHomeTimeRequests(telegram, { todayIso });
  return { enabled: true, ...result };
}

/**
 * What the run ledger is told about one tick. PURE.
 *
 * THE SUMMARY USED TO BE DISCARDED. The `withRunRecord` callback awaited both
 * sweeps and returned undefined, so `statusFromSummary` saw nothing and
 * recorded `ok` — including when Home Time is switched off entirely, where the
 * honest state is `blocked`. A feature nobody has enabled must not look
 * identical to one chasing reminders every five minutes.
 *
 * It is a function rather than an inline object so the rule can be tested
 * without driving the timer, which is the only reason `tick` itself is not
 * exported.
 */
function reminderRunSummary(cleanup) {
  if (cleanup?.enabled === false) {
    return { blocked: 'Home Time is switched off in Settings' };
  }
  return {
    scanned: cleanup?.scanned ?? 0,
    closed: cleanup?.closed ?? 0,
  };
}

async function tick() {
  if (tickRunning || !telegramClient) return;
  tickRunning = true;
  try {
    // THE SUMMARY IS RETURNED, not discarded. This arrow used to `await` both
    // sweeps and return undefined, so `statusFromSummary` saw nothing and
    // recorded `ok` — including when Home Time is switched off entirely, where
    // the honest ledger state is `blocked`. A feature nobody has enabled must
    // not look identical to one chasing reminders every five minutes.
    await withRunRecord('home_time_reminders', async () => reminderRunSummary(
      await runHomeTimeCleanupSweep(telegramClient),
    ));
    // Rides this service's cadence but is a SEPARATE responsibility: the two
    // sweeps above chase DRIVERS, this one chases STAFF. Required lazily so the
    // reminder tests can load this module without the alert outbox. Isolated in
    // its own try/catch so a staff-alert problem can never stop driver
    // reminders (or vice versa).
    try {
      const { runInternalAlertSweep } = require('./homeTimeInternalAlert');
      await runInternalAlertSweep(telegramClient);
    } catch (alertErr) {
      console.error('[HOME-TIME-INTERNAL] sweep error:', alertErr.message);
    }
    // The manager-notice retry. Every notice is attempted the moment its event
    // happens, so this only ever picks up what a Telegram hiccup deferred —
    // which is exactly why it can ride an existing five-minute ticker instead
    // of becoming a twenty-fifth background service.
    try {
      const { runManagerNoticeSweep } = require('./homeTime/managerNotices');
      await runManagerNoticeSweep(telegramClient);
    } catch (noticeErr) {
      console.error('[HOME-TIME-NOTICE] sweep error:', noticeErr.message);
    }
  } catch (err) {
    console.error('[HOME-TIME-REMINDER] tick error:', err.message);
  } finally {
    tickRunning = false;
  }
}

function startHomeTimeReminderService(telegram) {
  if (telegram) telegramClient = telegram;
  serviceStopped = false;
  console.log(`[HOME-TIME-REMINDER] Service started — sweeping due clarification reminders every ${POLL_MS / 60000}min`);
  setTimeout(() => { if (!serviceStopped) tick(); }, FIRST_TICK_DELAY_MS).unref?.();
  serviceTimer = setInterval(() => { if (!serviceStopped) tick(); }, POLL_MS);
  serviceTimer.unref?.();
}

function stopHomeTimeReminderService() {
  serviceStopped = true;
  if (serviceTimer) {
    clearInterval(serviceTimer);
    serviceTimer = null;
  }
}

module.exports = {
  runHomeTimeCleanupSweep,
  reminderRunSummary,
  startHomeTimeReminderService,
  stopHomeTimeReminderService,
  tick,
};
