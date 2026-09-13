'use strict';

/**
 * The weekly finance report: once a period, on Monday morning, or not at all.
 *
 * THE CLAIM COMES FIRST, BEFORE ANY WORK. `claimServiceRun` inserts a row and
 * reports whether it won. A redeploy on a Monday morning restarts every timer
 * in this application, and a weekly job whose only guard is "have I run since I
 * started?" sends the same report again — to a room of people who will
 * reasonably read the second one as meaning something. Claiming first makes the
 * race a database race, which has exactly one winner.
 *
 * AND THE CLAIM IS RELEASED IF THE SEND FAILS. A claim held after a failure is
 * a report that never arrives and never retries: the job would believe forever
 * that it had handled that week. `unclaimServiceRun` is what turns a failure
 * into a retry instead of a silent hole, and it is the half that is easy to
 * forget — this application has lost birthday wishes to exactly that.
 *
 * ONE WEEK PER TICK, NEVER A LOOP OVER MISSED WEEKS. If the application was
 * down for a month, a loop would fire four reports in four seconds. The tick
 * handles the most recent due period and stops; older weeks are on the Finance
 * page, which is where somebody looking for them would look.
 *
 * BACKFILL IS RECORDED, NOT SENT. If the monitor was switched on partway
 * through the period, a total drawn from it reads "$0 issued" when the truth is
 * "we were not watching". The row says `suppressed_backfill` and the claim is
 * KEPT, because that period is handled — it simply has no honest report.
 */

const db = require('../../database/db');
const reports = require('../../database/finance/reports');
const { getFinanceSettings } = require('../../database/financeSettings');
const { withRunRecord } = require('../operations/runLedger');
const { createDueTimeWakeTimer } = require('../dueTimeWakeTimer');
const { safeSend } = require('../telegramHtml');
const { notify } = require('../notifications/send');
const schedule = require('../../lib/finance/schedule');
const { composeWeeklyFinanceReport } = require('../../lib/finance/weeklyReport');

const SERVICE_NAME = 'finance_weekly_report';

let timer = null;

function log(message) {
  console.log(`[FINANCE REPORT] ${message}`);
}

/**
 * Where the report goes: its own chat if one is set, otherwise the finance
 * group it is about. Never a guess and never the default notification chat —
 * this is a payment summary, and it goes where somebody said payments go.
 */
function destinationFor(settings) {
  return settings.weeklyReportChatId || settings.chatId || null;
}

/**
 * Build and send one period's report.
 *
 * Split out of the tick so the admin's "send now" can reuse it without going
 * anywhere near the claim — a manual send is a person's deliberate act and is
 * not governed by the once-a-period rule.
 */
async function buildReport({ periodStart, periodEnd }) {
  const totals = await reports.summariseFinancePeriod({ periodStart, periodEnd });
  return { totals, body: composeWeeklyFinanceReport(totals, { periodStart, periodEnd }) };
}

/**
 * One tick. Never throws.
 *
 * @returns a summary `withRunRecord` reads, plus `dueAtMs` for the timer.
 */
async function runWeeklyReport(deps = {}) {
  const telegram = deps.telegram ?? null;
  const now = deps.now ? deps.now() : new Date();

  let settings;
  try {
    settings = await getFinanceSettings();
  } catch (err) {
    return { error: `the Finance Monitor settings could not be read (${err.message})` };
  }

  const nextDueAtMs = schedule.nextScheduledRun(now).getTime();

  if (!settings.enabled || !settings.weeklyReportEnabled) {
    return { blocked: 'the weekly finance report is switched off', dueAtMs: nextDueAtMs };
  }
  const chatId = destinationFor(settings);
  if (!chatId) {
    return { blocked: 'no chat is configured for the weekly finance report', dueAtMs: nextDueAtMs };
  }
  if (!telegram) {
    return { blocked: 'no Telegram client is available', dueAtMs: nextDueAtMs };
  }

  const scheduledFor = schedule.mostRecentScheduledRun(now);
  const { periodStart, periodEnd } = schedule.periodFor(scheduledFor);
  const runKey = schedule.runKeyFor(periodStart);

  // THE CLAIM, BEFORE ANY WORK. Losing it means somebody else has this week.
  const won = await db.claimServiceRun(SERVICE_NAME, runKey);
  if (!won) {
    return { skipped: 'this week has already been reported', dueAtMs: nextDueAtMs };
  }

  if (schedule.isBackfill(periodStart, settings.enabledAt)) {
    // The claim is KEPT: the period is handled. It has no honest report,
    // which is a different thing from not having been looked at.
    await reports.recordReport({
      periodStart, periodEnd, scheduledFor, status: 'suppressed_backfill',
      chatId, totals: null, body: null,
      error: 'the Finance Monitor was not watching for all of this period',
    });
    log(`period ${runKey} predates the monitor — recorded, not sent`);
    return { skipped: 'the period predates the Finance Monitor', dueAtMs: nextDueAtMs };
  }

  let built;
  try {
    built = await buildReport({ periodStart, periodEnd });
  } catch (err) {
    // Could not even count it. Release the claim so next tick tries again.
    await db.unclaimServiceRun(SERVICE_NAME, runKey).catch(() => false);
    return { error: `the weekly finance totals could not be counted (${err.message})` };
  }

  try {
    const sent = await safeSend(() => telegram.sendMessage(chatId, built.body, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }));
    await reports.recordReport({
      periodStart, periodEnd, scheduledFor, status: 'sent', chatId,
      telegramMessageId: sent?.message_id ?? null,
      totals: built.totals, body: built.body, sentAt: new Date(),
    });
    log(`sent the report for ${runKey}`);
    return { sent: 1, period: runKey, dueAtMs: nextDueAtMs };
  } catch (err) {
    // THE HALF THAT IS EASY TO FORGET. Without this the job believes forever
    // that it handled this week, and the report simply never arrives.
    await db.unclaimServiceRun(SERVICE_NAME, runKey).catch(() => false);
    await reports.recordReport({
      periodStart, periodEnd, scheduledFor, status: 'failed', chatId,
      totals: built.totals, body: built.body, error: String(err.message).slice(0, 500),
    }).catch(() => null);
    await notify({
      category: 'finance',
      title: 'The weekly money-code report could not be sent',
      lines: ['It will be tried again. The figures themselves are safe.'],
      action: 'Check that the finance group is a chat the bot can still reach.',
      subjectType: 'finance_report',
      subjectId: runKey,
    }).catch(() => null);
    return { error: `the weekly finance report could not be sent (${err.message})`, retry: true };
  }
}

/** One tick, wrapped so /api/health can say whether it ran. Never throws. */
async function tick(deps = {}) {
  let summary;
  try {
    // THE KEY IS A LITERAL HERE ON PURPOSE. `tests/backgroundServiceCatalog`
    // greps for `withRunRecord('<key>'` to prove every catalogued worker is
    // actually observed, and a constant hides it from exactly the check that
    // exists because an unobserved worker reads "never reported" forever.
    summary = await withRunRecord('finance_weekly_report', () => runWeeklyReport(deps));
  } catch (err) {
    log(`tick failed: ${err.message}`);
    summary = { error: err.message };
  }
  return {
    retry: Boolean(summary?.retry || summary?.error),
    dueAtMs: summary?.dueAtMs ?? schedule.nextScheduledRun().getTime(),
  };
}

function startFinanceWeeklyReport(deps = {}) {
  if (timer) return timer;
  timer = createDueTimeWakeTimer({
    runTick: () => tick(deps),
    label: 'FINANCE REPORT',
  });
  timer.start?.();
  return timer;
}

function stopFinanceWeeklyReport() {
  timer?.stop?.();
  timer = null;
}

module.exports = {
  SERVICE_NAME,
  runWeeklyReport,
  buildReport,
  destinationFor,
  tick,
  startFinanceWeeklyReport,
  stopFinanceWeeklyReport,
};
