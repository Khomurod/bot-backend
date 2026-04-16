const fs = require('fs');
const path = require('path');
const db = require('../database/db');

// Manual aliases for drivers with different spellings or specific group mappings
const ALIASES = {
  'EARNST BRUTUS': 'ERNST BRUTUS',
  'AVAZBEK MALIKOV': 'AVAZBEK',
  'USMON BEGJANOV': 'USMON',
  'SIROJKHON AZIMOV': 'SIROJKHON',
  'ZIYOVADDIN AZIMOV': 'ZIYOVADDIN'
};

async function run() {
  const csvPath = path.join(__dirname, '../birthdays.csv');
  if (!fs.existsSync(csvPath)) {
    console.error('CSV file not found at:', csvPath);
    process.exit(1);
  }

  const content = fs.readFileSync(csvPath, 'utf8');
  const rows = content.split('\n').filter(row => row.trim() !== '');

  console.log(`[IMPORT] Read ${rows.length} rows from CSV.`);

  try {
    const groupsRes = await db.query("SELECT id, group_name FROM groups WHERE group_type = 'driver' AND active = TRUE");
    const activeGroups = groupsRes.rows;
    console.log(`[IMPORT] Fetched ${activeGroups.length} active driver groups.`);

    let successCount = 0;
    let failCount = 0;
    let sharedMatches = 0;

    const matchedGroupIds = new Set();

    for (const row of rows) {
      const parts = row.split(',');
      if (parts.length < 2) continue;
      
      let name = parts[0].trim();
      const dateStr = parts[1].trim();

      if (!name || !dateStr) continue;

      // Check if name has an alias/special mapping
      const searchName = ALIASES[name.toUpperCase()] || name;

      // Find match: name is a substring of group_name (case-insensitive)
      const match = activeGroups.find(g => g.group_name.toUpperCase().includes(searchName.toUpperCase()));

      if (match) {
        if (matchedGroupIds.has(match.id)) {
          console.log(`[SHARED] Group "${match.group_name}" shared. Updating with ${name}'s birthday (${dateStr}).`);
          sharedMatches++;
        }
        
        await db.query('UPDATE groups SET driver_birthday = $1 WHERE id = $2', [dateStr, match.id]);
        console.log(`[OK] Matched "${name}" -> "${match.group_name}" (${dateStr})`);
        
        matchedGroupIds.add(match.id);
        successCount++;
      } else {
        console.warn(`[!] No match for "${name}"`);
        failCount++;
      }
    }

    console.log('\n═══════════════════════════════════════════');
    console.log('   IMPORT SUMMARY (REFINED)');
    console.log('═══════════════════════════════════════════');
    console.log(`Total Rows Processed: ${rows.length}`);
    console.log(`Successfully Updated: ${successCount}`);
    console.log(`Shared Group Updates: ${sharedMatches}`);
    console.log(`Unmatched Drivers:    ${failCount}`);
    console.log('═══════════════════════════════════════════');
    
    if (failCount > 0) {
      console.log('\nNOTE: The unmatched drivers do not appear to have a registered Telegram group in the database.');
    }

    process.exit(0);
  } catch (err) {
    console.error('[IMPORT] Fatal Error:', err.message);
    process.exit(1);
  }
}

run();
