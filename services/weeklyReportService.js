const { DateTime } = require('luxon');
const db = require('../database/db');
const config = require('../config/config');
const { bot } = require('../bot/bot');
const { buildTelegramMessageUrl } = require('./telegramUrl');
const { generateCompanyReport, AI_REPORT_GENERATION_FAILED } = require('./aiAnalysisService');

let lastRunDate = null;
let running = false;

function mapLogsToTranscript(logs) {
  return logs.map((log) => {
    const link = buildTelegramMessageUrl(log.telegram_group_id, log.telegram_message_id);
    const messageText = String(log.message_text || '').replace(/\s+/g, ' ').trim();
    const senderName = String(log.sender_name || 'Unknown');
    const groupName = String(log.group_name || 'Unknown Group');
    const linkPrefix = link ? `[Link: ${link}] ` : '';
    return {
      ...log,
      transcript_line: `[Group: ${groupName}] ${linkPrefix}${senderName}: ${messageText}`,
    };
  }).filter((log) => log.message_text);
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

    await bot.telegram.sendMessage(config.managementGroupId, report, { parse_mode: 'HTML' });
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
  console.log('[WEEKLY-REPORT] Service started. Checking every minute.');
  
  // Check immediately at startup.
  checkAndRun().catch((err) => {
    console.error('[WEEKLY-REPORT] Initial check failed:', err.message);
  });

  // Then check every minute for strict 7:00 AM trigger.
  setInterval(() => {
    checkAndRun().catch((err) => {
      console.error('[WEEKLY-REPORT] Periodic check failed:', err.message);
    });
  }, 60 * 1000);
}

async function checkAndRun(nowChicago = DateTime.now().setZone('America/Chicago')) {
  const dayOfWeek = nowChicago.weekday; // Monday = 1
  const hour = nowChicago.hour;
  const minute = nowChicago.minute;
  const dateStr = nowChicago.toISODate();

  if (dayOfWeek === 1 && hour === 7 && minute === 0 && lastRunDate !== dateStr) {
    lastRunDate = dateStr;
    return runWeeklyAnalysis(nowChicago);
  }
  return false;
}

module.exports = {
  startWeeklyReporter,
  checkAndRun,
  runWeeklyAnalysis,
};
