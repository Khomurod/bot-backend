/**
 * Apply pending forward migrations WITHOUT a full app boot.
 *
 * Applies the baseline (database/schema.sql) and then every un-applied
 * migration in database/migrations/, recording each in the schema_migrations
 * ledger. Idempotent: re-running when nothing is pending is a no-op.
 *
 *   node scripts/migrate.js           # apply baseline + pending migrations
 *   node scripts/migrate.js --status  # report ledger state, apply nothing
 *
 * Uses the same DATABASE_URL / pool as the app.
 */
// Startup boundary: fail fast with a clear message when DATABASE_URL etc. are
// missing, instead of letting pg fall back to confusing localhost defaults.
require('../config/config').assertRequiredConfig();

const fs = require('node:fs');
const { pool } = require('../database/pool');
const {
  runMigrations, loadMigrations, checksum, ledger, MIGRATIONS_DIR, BASELINE_PATH,
} = require('../database/migrate');

async function status() {
  await ledger.ensureLedger(pool);
  const applied = await ledger.getApplied(pool);
  const onDisk = loadMigrations(MIGRATIONS_DIR);
  console.log(`[migrate] ledger: ${applied.size} forward migration(s) applied`);
  for (const m of onDisk) {
    const state = applied.has(m.version) ? 'applied' : 'PENDING';
    console.log(`  ${m.filename.padEnd(48)} ${state}`);
  }
  if (!onDisk.length) console.log('  (no forward migrations on disk)');
}

(async () => {
  try {
    if (process.argv.includes('--status')) {
      await status();
      await pool.end();
      process.exit(0);
    }

    const schema = fs.readFileSync(BASELINE_PATH, 'utf-8');
    console.log('[migrate] applying baseline (database/schema.sql)...');
    const baselineStart = process.hrtime.bigint();
    await pool.query(schema);
    const baselineMs = Number((process.hrtime.bigint() - baselineStart) / 1000000n);

    const result = await runMigrations(pool, {
      migrationsDir: MIGRATIONS_DIR,
      baselineChecksum: checksum(schema),
      baselineMs,
    });

    console.log(
      `[migrate] done. applied=${result.applied.length} `
      + `skipped=${result.skipped.length} drift=${result.drift.length}`,
    );
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('[migrate] FAILED:', err.message);
    await pool.end().catch(() => {});
    process.exit(1);
  }
})();
