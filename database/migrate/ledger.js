'use strict';

/**
 * The `schema_migrations` ledger: the record of which migrations have been
 * applied to a database, and the baseline's current checksum.
 *
 * This table is created and owned by the migration runner (NOT by
 * database/schema.sql), so the baseline schema file — and every test that
 * applies it — stays free of migration bookkeeping. The table is additive and
 * created with IF NOT EXISTS, so it is safe on a database shared with other
 * services and safe to introduce on an already-populated production database.
 *
 * Rows:
 *   - one row per applied forward migration, keyed by its version string
 *   - one sentinel row (version = BASELINE_VERSION) recording the baseline's
 *     last-applied checksum and time, refreshed every boot
 */

const BASELINE_VERSION = '00000000000000_baseline';

const CREATE_LEDGER_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version       TEXT PRIMARY KEY,
  checksum      TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'versioned',
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  execution_ms  INTEGER
);`;

/** Create the ledger table if it does not exist. Idempotent. */
async function ensureLedger(executor) {
  await executor.query(CREATE_LEDGER_SQL);
}

/**
 * @returns {Promise<Map<string,{checksum:string, kind:string}>>} applied
 *   forward migrations keyed by version (the baseline sentinel is excluded).
 */
async function getApplied(executor) {
  const res = await executor.query(
    'SELECT version, checksum, kind FROM schema_migrations WHERE version <> $1',
    [BASELINE_VERSION],
  );
  const map = new Map();
  for (const row of res.rows) {
    map.set(row.version, { checksum: row.checksum, kind: row.kind });
  }
  return map;
}

/** Record a successfully applied forward migration. */
async function recordMigration(executor, { version, checksum, kind, executionMs }) {
  await executor.query(
    `INSERT INTO schema_migrations (version, checksum, kind, execution_ms)
     VALUES ($1, $2, $3, $4)`,
    [version, checksum, kind || 'schema', executionMs ?? null],
  );
}

/**
 * Upsert the baseline sentinel row. The baseline is re-applied on every boot
 * (it is idempotent), so this refreshes its checksum + timestamp rather than
 * insisting on immutability.
 */
async function recordBaseline(executor, { checksum, executionMs }) {
  await executor.query(
    `INSERT INTO schema_migrations (version, checksum, kind, applied_at, execution_ms)
     VALUES ($1, $2, 'baseline', NOW(), $3)
     ON CONFLICT (version) DO UPDATE
       SET checksum = EXCLUDED.checksum,
           applied_at = EXCLUDED.applied_at,
           execution_ms = EXCLUDED.execution_ms`,
    [BASELINE_VERSION, checksum, executionMs ?? null],
  );
}

module.exports = {
  BASELINE_VERSION,
  CREATE_LEDGER_SQL,
  ensureLedger,
  getApplied,
  recordMigration,
  recordBaseline,
};
