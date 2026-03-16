/**
 * Migration: Add media columns to questions table.
 * Run: node scripts/migrate-media.js
 */
const db = require('../database/db');

(async () => {
  try {
    console.log('[MIGRATE] Adding media columns to questions table...');
    await db.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS media_file_id TEXT`);
    await db.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS media_type TEXT`);
    await db.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS media_position TEXT DEFAULT 'above'`);
    console.log('[MIGRATE] Migration complete.');
    process.exit(0);
  } catch (err) {
    console.error('[MIGRATE] Migration failed:', err.message);
    process.exit(1);
  }
})();
