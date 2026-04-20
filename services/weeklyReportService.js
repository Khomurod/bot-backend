const db = require('../database/db');
const { analyzeChatLogs, AI_REPORT_GENERATION_FAILED } = require('./aiAnalysisService');

let lastRunDate = null;

async function runWeeklyAnalysis() {
  console.log('[WEEKLY-REPORT] Starting weekly chat analysis...');
  try {
    const groups = await db.getAllDriverGroups();
    
    for (const group of groups) {
      const logs = await db.getChatLogsForGroup(group.id, 8);
      if (logs && logs.length > 0) {
        console.log(`[WEEKLY-REPORT] Analyzing logs for group: ${group.group_name}`);
        const report = await analyzeChatLogs(group.group_name, logs);

        if (!report || report === AI_REPORT_GENERATION_FAILED) {
          console.log(`[WEEKLY-REPORT] AI generation failed for group "${group.group_name}". Draft was not saved.`);
          continue;
        }

        await db.saveAiReport(group.id, report);
        console.log(`[WEEKLY-REPORT] Draft saved for admin review: group="${group.group_name}"`);
      } else {
        console.log(`[WEEKLY-REPORT] No logs for group: ${group.group_name}`);
      }
    }
    
    // Clean up old logs
    await db.deleteOldChatLogs(8);
    console.log('[WEEKLY-REPORT] Analysis complete and old logs deleted.');
  } catch (err) {
    console.error('[WEEKLY-REPORT] Error in weekly analysis:', err.message);
  }
}

function startWeeklyReporter() {
  console.log('[WEEKLY-REPORT] Service started. Checking every hour.');
  
  // Check once on startup to handle cases where it wakes up on Monday after 9 AM
  checkAndRun();

  // Then check every hour
  setInterval(checkAndRun, 60 * 60 * 1000);
}

function checkAndRun() {
  const now = new Date();
  const day = now.getDay(); // 1 = Monday
  const hour = now.getHours();
  const dateStr = now.toDateString();

  // If it is Monday and at or after 9 AM, and we haven't run today
  if (day === 1 && hour >= 9 && lastRunDate !== dateStr) {
    lastRunDate = dateStr;
    runWeeklyAnalysis();
  }
}

module.exports = {
  startWeeklyReporter,
};
