const { DateTime } = require('luxon');
const db = require('../database/db');
const config = require('../config/config');
const { bot } = require('../bot/bot');
const { sanitizeCompanyReportHtmlForTelegram, sendTelegramHtmlChunks } = require('./telegramHtml');
const { generateCompanyReport, AI_REPORT_GENERATION_FAILED } = require('./aiAnalysisService');
const { buildTelegramMessageUrl } = require('./telegramUrl');

let running = false;
let reporterTimer = null;
let reporterStopped = false;

async function runWeeklyAnalysis(nowChicago = DateTime.now().setZone('America/Chicago')) {
  if (running) return false;
  running = true;

  console.log('[WEEKLY-REPORT] Starting weekly company analysis...');
  try {
    const daysBack = 7;
    const logs = await db.getChatLogsForActiveDriverGroups(daysBack);
    if (!logs || logs.length === 0) {
      console.log('[WEEKLY-REPORT] No logs found to generate report.');
      return false;
    }

    const transcriptReadyLogs = logs.map((log) => {
      const link = buildTelegramMessageUrl(log.telegram_group_id, log.telegram_message_id);
      const rawText = log.message_text;
      const messageText = rawText == null || rawText === ''
        ? '(no message text)'
        : String(rawText).replace(/\s+/g, ' ').trim();
      const senderName = String(log.sender_name || 'Unknown');
      const groupName = String(log.group_name || 'Unknown Group');
      const linkPrefix = link ? `[Link: ${link}] ` : '';
      const transcript_line = link
        ? `[Group: ${groupName}] ${linkPrefix}${senderName}: ${messageText}`
        : `[Group: ${groupName}] ${senderName}: ${messageText}`;
      return {
        ...log,
        transcript_line,
      };
    });

    const reportText = await generateCompanyReport(transcriptReadyLogs);
    if (!reportText || reportText === AI_REPORT_GENERATION_FAILED) {
      console.log('[WEEKLY-REPORT] Report generation failed.');
      return false;
    }

    const report = await db.saveAiReport(null, reportText, 'company');

    const [overallRaw, breakdownRaw] = String(reportText || '').split('|||');
    const companyBody = breakdownRaw
      ? `${sanitizeCompanyReportHtmlForTelegram(overallRaw)}\n\n${sanitizeCompanyReportHtmlForTelegram(breakdownRaw)}`
      : sanitizeCompanyReportHtmlForTelegram(reportText);

    const escapeHtml = (text) => String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const message = [
      '📊 <b>Company AI Weekly Dispatch Report</b>',
      `<b>Generated:</b> ${escapeHtml(new Date().toLocaleString())}`,
      '',
      companyBody || 'Report unavailable.',
    ].join('\n');

    await sendTelegramHtmlChunks(bot.telegram, config.managementGroupId, message);
    await db.updateAiReportStatus(report.id, 'sent');

    console.log(`[WEEKLY-REPORT] Report ${report.id} sent.`);
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
