const { DateTime } = require('luxon');
const db = require('../database/db');
const config = require('../config/config');
const { bot } = require('../bot/bot');
const { buildTelegramMessageUrl } = require('./telegramUrl');
const { sanitizeCompanyReportHtmlForTelegram, sendTelegramHtmlChunks } = require('./telegramHtml');
const { generateCompanyReport, AI_REPORT_GENERATION_FAILED } = require('./aiAnalysisService');

let running = false;
let reporterTimer = null;
let reporterStopped = false;

function mapLogsToTranscript(logs) {
  return logs.map((log) => {
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
}

async function runWeeklyAnalysis(nowChicago = DateTime.now().setZone('America/Chicago')) {
  if (running) return false;
  running = true;

  console.log('[WEEKLY-REPORT] Starting weekly company analysis...');
  try {
    const logs = await db.getChatLogsForActiveDriverGroups(7);
    if (!logs || logs.length === 0) {
      console.log('[WEEKLY-REPORT] No logs found for weekly company report.');
      return false;
    }

    const transcriptLogs = mapLogsToTranscript(logs);
    if (!transcriptLogs.length) {
      console.log('[WEEKLY-REPORT] No valid transcript lines for weekly company report.');
      return false;
    }

    const report = await generateCompanyReport(transcriptLogs);
    if (!report || report === AI_REPORT_GENERATION_FAILED) {
      console.log('[WEEKLY-REPORT] AI generation failed for company report.');
      return false;
    }

    const safe = sanitizeCompanyReportHtmlForTelegram(report);
    await sendTelegramHtmlChunks(bot.telegram, config.managementGroupId, safe);
    await db.query(
      `INSERT INTO ai_reports (group_id, report_text, report_type, status, sent_at)
       VALUES ($1, $2, 'company', 'sent', NOW())`,
      [null, report]
    );
    console.log('[WEEKLY-REPORT] Company report sent and saved.');
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
 * idempotency. The per-process `running` flag still guards against two
 * concurrent analyses in the same process.
 */
async function checkAndRun(nowChicago = DateTime.now().setZone('America/Chicago')) {
  const dayOfWeek = nowChicago.weekday; // Monday = 1
  const hour = nowChicago.hour;
  const minute = nowChicago.minute;

  if (!(dayOfWeek === 1 && hour === 7 && minute === 0)) return false;

  // Use the ISO week as the idempotency key — regardless of how many ticks
  // fall inside the 07:00 minute, only the first one will claim the row.
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
