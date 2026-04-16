const { DateTime } = require('luxon');
const db = require('../database/db');
const { bot } = require('../bot/bot');
const config = require('../config/config');

let hasRunToday = false;
let hasRunEmployeeToday = false;
let lastRunDate = null;

async function checkAndSendBirthdays() {
  const now = DateTime.now().setZone('America/Chicago');

  // Reset the "hasRunToday" flag if the date has changed
  if (lastRunDate !== now.toISODate()) {
    hasRunToday = false;
    hasRunEmployeeToday = false;
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
        
        const message = `🥳🚛 <b>Happy Birthday, ${driverName}!</b> 🚛🥳\n\nToday we’re celebrating not just another year, but the miles you’ve conquered, the dedication you show every day, and the reliability you bring to our team. 💪\n\n${driverName}, your hard work keeps everything moving forward—literally! From early mornings to long hauls, you handle it all with professionalism and strength. We truly appreciate the commitment and positive energy you bring to the road and to our company. 🌍✨\n\nMay this year bring you smooth roads, safe journeys, great health, and plenty of reasons to smile both on and off the road. 🛣️😊\n\nEnjoy your special day—you’ve earned it! 🎂🎈\n\n<b>Happy Birthday and keep on truckin’! 🚚🔥</b>`;
        
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

  // Trigger exactly at 9 AM Central Time for Office Employees
  if (now.hour === 9 && !hasRunEmployeeToday) {
    hasRunEmployeeToday = true;
    try {
      const month = now.month;
      const day = now.day;
      const empBirthdays = await db.getEmployeesWithBirthdayToday(month, day);
      
      if (empBirthdays.length > 0 && config.employeeGroupId) {
        const names = empBirthdays.map(e => `${e.first_name} ${e.last_name}`).join(', ');
        const message = `🎉 <b>Happy Birthday!</b> 🎂\n\nToday we celebrate the birthday of our amazing team member(s):\n<b>${names}</b>!\n\nWishing you a fantastic day and a great year ahead! 🥳\n\n— <i>Wenze Management</i>`;
        
        await bot.telegram.sendMessage(config.employeeGroupId, message, { parse_mode: 'HTML' });
        console.log(`[BIRTHDAY] Sent employee birthday wish to ${names}`);
      }
    } catch (err) {
      console.error('[BIRTHDAY] Error processing employee birthdays:', err.message);
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
