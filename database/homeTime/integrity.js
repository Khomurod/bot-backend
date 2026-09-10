/**
 * The invariant the schema never held: ONE open home stay per group.
 *
 * `getOpenHomeStay` is `LIMIT 1`, so a second open cycle for a group hides the
 * first forever — 25 rows in production were unreachable that way. The partial
 * unique index below makes a second open row something the database refuses.
 *
 * It is created HERE, at boot, and never in a migration: a migration that hit
 * the 25 duplicates would fail, and a failing migration takes the application
 * down inside `initializeDatabase()` (the lesson of migration 0014). This guard
 * counts first. With zero duplicates it creates the index (idempotent; a second
 * boot finds it present). With any, it logs and stands down — the Stage 3
 * repair closes them through the audited registry, and the next boot succeeds.
 * Nothing here can fail boot: every path returns a status.
 */
const { query } = require('../pool');

const INDEX_NAME = 'uniq_driver_road_history_open_stay';

async function countDuplicateOpenStays() {
  const res = await query(
    `SELECT group_id, COUNT(*)::int AS open_rows
       FROM driver_road_history
      WHERE return_to_road_at IS NULL
      GROUP BY group_id
     HAVING COUNT(*) > 1
      ORDER BY group_id`
  );
  return res.rows;
}

async function indexExists() {
  const res = await query('SELECT 1 FROM pg_indexes WHERE indexname = $1', [INDEX_NAME]);
  return res.rows.length > 0;
}

/**
 * @returns {Promise<{status:'present'|'created'|'blocked'|'error', duplicates:number,
 *   groups?:number[], error?:string}>}
 */
async function ensureOpenStayIndex() {
  try {
    if (await indexExists()) return { status: 'present', duplicates: 0 };
    const duplicates = await countDuplicateOpenStays();
    if (duplicates.length) {
      console.warn(`[HOME-TIME] Open-stay unique index NOT created: ${duplicates.length} group(s) still hold `
        + 'more than one open home stay. Close them through Needs Attention (home_time.closable_open_cycle) first.');
      return { status: 'blocked', duplicates: duplicates.length, groups: duplicates.map((r) => r.group_id) };
    }
    await query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}
         ON driver_road_history (group_id) WHERE return_to_road_at IS NULL`
    );
    console.log('[HOME-TIME] Open-stay unique index created: a second open home stay per group is now refused.');
    return { status: 'created', duplicates: 0 };
  } catch (err) {
    console.error('[HOME-TIME] Open-stay index guard failed:', err.message);
    return { status: 'error', duplicates: -1, error: err.message };
  }
}

module.exports = { INDEX_NAME, ensureOpenStayIndex, countDuplicateOpenStays, indexExists };
