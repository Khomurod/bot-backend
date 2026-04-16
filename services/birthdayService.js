const { DateTime } = require('luxon');
const db = require('../database/db');
const { bot } = require('../bot/bot');

let hasRunToday = false;
let lastRunDate = null;

async function checkAndSendBirthdays() {
  const now = DateTime.now().setZone('America/Chicago');

  // Reset the "hasRunToday" flag if the date has changed
  if (lastRunDate !== now.toISODate()) {
    hasRunToday = false;
    lastRunDate = now.toISODate();
  }

  // Trigger exactly at 8 AM Central Time
  if (now.hour === 8 && !hasRunToday) {
    hasRunToday = true;
    
    try {
      const month = now.month;
      const day = now.day;
      const birthdayGroups = await db.getGroupsWithBirthdayToday(month, day);
      
      if (birthdayGroups.length > 0) {
        console.log(`[BIRTHDAY] Found ${birthdayGroups.length} birthday(s) today!`);
      }

      for (const group of birthdayGroups) {
        // Attempt to extract driver name from group name (e.g., removing "WENZE UNIT # 800")
        let driverName = group.group_name.replace(/^.*?(UNIT\s*#?\s*\d+|#\s*\d+)\s+/i, '').replace(/\(.*?\)/g, '').trim();
        if (!driverName || driverName === group.group_name) {
          driverName = "Driver"; // Fallback
        }
        
        const message = `🎉 <b>Happy Birthday, ${driverName}!</b> 🎂\n\nWishing you a fantastic day, great health, and safe travels on the road! 🚛💨\n\n— <i>From the Wenze Team</i>`;
        
        try {
          await bot.telegram.sendMessage(group.telegram_group_id, message, { parse_mode: 'HTML' });
          console.log(`[BIRTHDAY] Sent wish to ${group.group_name}`);
        } catch (err) {
          console.error(`[BIRTHDAY] Failed to send to ${group.group_name}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[BIRTHDAY] Error processing birthdays:', err.message);
    }
  }
}

function startBirthdayService() {
  console.log('[BIRTHDAY] Service started. Checking for 8 AM CT daily.');
  // Check every 60 seconds to ensure we hit the 8 AM window
  setInterval(checkAndSendBirthdays, 60 * 1000);
  checkAndSendBirthdays(); // Initial run on startup
}

module.exports = { startBirthdayService };
