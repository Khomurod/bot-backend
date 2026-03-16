/**
 * Migration: Upgrade from single-media to multi-media (question_media table).
 * Run ONCE on existing databases: node scripts/migrate-multi-media.js
 *
 * What this does:
 * 1. Creates the question_media table
 * 2. Migrates any existing single-media rows from questions → question_media
 * 3. Drops media_file_id and media_type columns from questions
 *    (media_position is kept on questions)
 */
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Ensure media_position column exists on questions table
    await client.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS media_position TEXT DEFAULT 'above'`);
    console.log('[MIGRATE] media_position column ensured on questions table.');

    // 2. Create question_media table
    await client.query(`
      CREATE TABLE IF NOT EXISTS question_media (
        id SERIAL PRIMARY KEY,
        question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL,
        media_type TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0
      )
    `);
    console.log('[MIGRATE] question_media table created (or already exists).');

    // 2. Check if the old columns still exist on questions
    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'questions' AND column_name = 'media_file_id'
    `);

    if (colCheck.rows.length > 0) {
      // 3. Migrate existing single-media records
      const existing = await client.query(`
        SELECT id, media_file_id, media_type FROM questions
        WHERE media_file_id IS NOT NULL
      `);

      if (existing.rows.length > 0) {
        console.log(`[MIGRATE] Migrating ${existing.rows.length} existing media record(s)...`);
        for (const row of existing.rows) {
          await client.query(
            `INSERT INTO question_media (question_id, file_id, media_type, sort_order)
             VALUES ($1, $2, $3, 0)`,
            [row.id, row.media_file_id, row.media_type || 'photo']
          );
        }
        console.log('[MIGRATE] Existing media migrated to question_media.');
      } else {
        console.log('[MIGRATE] No existing media records to migrate.');
      }

      // 4. Drop old columns from questions
      await client.query(`ALTER TABLE questions DROP COLUMN IF EXISTS media_file_id`);
      await client.query(`ALTER TABLE questions DROP COLUMN IF EXISTS media_type`);
      console.log('[MIGRATE] Dropped media_file_id and media_type columns from questions.');
    } else {
      console.log('[MIGRATE] Old media columns already removed — skipping column migration.');
    }

    await client.query('COMMIT');
    console.log('[MIGRATE] Migration complete. ✅');
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[MIGRATE] Migration FAILED (rolled back):', err.message);
    process.exit(1);
  } finally {
    client.release();
  }
})();
