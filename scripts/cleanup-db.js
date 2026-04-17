const db = require('../database/db');

(async () => {
  try {
    console.log('[CLEANUP] Canceling pending scheduled messages...');
    await db.query("UPDATE scheduled_messages SET status = 'cancelled' WHERE status = 'pending'");
    console.log('[CLEANUP] Pending messages cancelled.');

    console.log('[CLEANUP] Removing stale pre-supergroup duplicate IDs...');
    // Delete groups that have a positive or short negative ID IF a -100 version of the same name exists
    await db.query(`
      DELETE FROM groups a
      USING groups b
      WHERE a.group_name = b.group_name 
        AND a.id > b.id 
        AND a.telegram_group_id::text NOT LIKE '-100%' 
        AND b.telegram_group_id::text LIKE '-100%';
    `);
    console.log('[CLEANUP] Duplicate groups cleaned.');

    process.exit(0);
  } catch (err) {
    console.error('[CLEANUP] Error:', err.message);
    process.exit(1);
  }
})();
