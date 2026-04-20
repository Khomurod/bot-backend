const { DateTime } = require('luxon');
const db = require('../database/db');
const config = require('../config/config');
const { bot } = require('../bot/bot');
const { sanitizeCompanyReportHtmlForTelegram, sendTelegramHtmlChunks } = require('./telegramHtml');
const { generateInsightReport } = require('./aiInsightsService');
const { renderInsightReportForTelegram } = require('./insightRenderer');

let running = false;
let reporterTimer = null;
let reporterStopped = false;

async function runWeeklyAnalysis(nowChicago = DateTime.now().setZone('America/Chicago')) {
  if (running) return false;
  running = true;

  console.log('[WEEKLY-REPORT] Starting weekly company analysis (insights v2)...');
  try {
    const result = await generateInsightReport({
      daysBack: 7,
      reportType: 'company',
    });

    if (!result.report) {
      console.log('[WEEKLY-REPORT] No insights generated:', result.reason || 'unknown');
      return false;
    }

    const cards = await db.getInsightsForReport(result.report.id);
    const html = renderInsightReportForTelegram({ report: result.report, cards, pulse: result.pulse });
    const safe = sanitizeCompanyReportHtmlForTelegram(html);
    await sendTelegramHtmlChunks(bot.telegram, config.managementGroupId, safe);

    // Mark envelope + all cards as sent
    await db.updateAiReportStatus(result.report.id, 'sent');
    for (const card of cards) {
      await db.updateInsightStatus(card.id, 'sent');
    }

    console.log(`[WEEKLY-REPORT] Insight report ${result.report.id} sent. Cards: ${cards.length}`);
    return true;
  } catch (err) {
    console.error('[WEEKLY-REPORT] Error in weekly analysis:', err.message);
    return false;
  } finally {
    running = false;
  }
}

function startWeeklyReporter() {
  console.log('[WEEKLY-REPORT] Service started. Checking every minute (Mon 07:00 America/Chicago).');
  reporterStopped = false;

  checkAndRun().catch((err) => {
    console.error('[WEEKLY-REPORT] Initial check failed:', err.message);
  });

  reporterTimer = setInterval(() => {
    if (reporterStopped) return;
    checkAndRun().catch((err) => {
      console.error('[WEEKLY-REPORT] Periodic check failed:', err.message);
    });
  }, 60 * 1000);
}

function stopWeeklyReporter() {
  reporterStopped = true;
  if (reporterTimer) {
    clearInterval(reporterTimer);
    reporterTimer = null;
  }
}

/**
 * Trigger the Monday 07:00 America/Chicago weekly analysis at-most-once
 * per ISO-week, using service_runs for cross-restart / multi-instance
 * idempotency.
 */
async function checkAndRun(nowChicago = DateTime.now().setZone('America/Chicago')) {
  const dayOfWeek = nowChicago.weekday; // Monday = 1
  const hour = nowChicago.hour;
  const minute = nowChicago.minute;

  if (!(dayOfWeek === 1 && hour === 7 && minute === 0)) return false;

  const runKey = `weekly-company:${nowChicago.weekYear}-W${String(nowChicago.weekNumber).padStart(2, '0')}`;
  const claimed = await db.claimServiceRun('weekly_report', runKey);
  if (!claimed) return false;

  return runWeeklyAnalysis(nowChicago);
}

module.exports = {
  startWeeklyReporter,
  stopWeeklyReporter,
  checkAndRun,
  runWeeklyAnalysis,
};
