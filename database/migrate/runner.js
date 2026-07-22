'use strict';

/**
 * The forward-migration apply loop.
 *
 * Contract (production boot path, called from database/db.js after the baseline
 * schema has been applied):
 *   1. ensure the schema_migrations ledger exists
 *   2. refresh the baseline sentinel (the baseline re-runs every boot)
 *   3. apply every forward migration not yet in the ledger, in version order,
 *      each atomically (migration SQL + its ledger row commit together)
 *
 * Failures are fatal by design: a throw here propagates to initializeDatabase
 * and aborts boot, exactly as a failing baseline statement does today. A partial
 * migration is never recorded, so the next boot retries it from a clean state.
 *
 * Already-applied migrations are never re-run. If an applied migration's file
 * has been edited (checksum drift) the runner WARNS but does not fail boot —
 * the change was never executed, so this is an integrity signal for humans, not
 * a reason to brick a production restart.
 */
const { loadMigrations } = require('./loader');
const { splitStatements } = require('./splitStatements');
const ledger = require('./ledger');

function elapsedMs(startNs) {
  return Number((process.hrtime.bigint() - startNs) / 1000000n);
}

async function applyInTransaction(pool, migration) {
  const client = await pool.connect();
  const started = process.hrtime.bigint();
  try {
    await client.query('BEGIN');
    await client.query(migration.sql);
    await ledger.recordMigration(client, {
      version: migration.version,
      checksum: migration.checksum,
      kind: migration.kind,
      executionMs: elapsedMs(started),
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function applyWithoutTransaction(pool, migration) {
  const started = process.hrtime.bigint();
  // No BEGIN/COMMIT: statements like CREATE INDEX CONCURRENTLY forbid it. Each
  // statement is sent on its own — a multi-statement query would itself form an
  // implicit transaction block, which is exactly what these statements reject.
  // The migration must be internally idempotent (see loader.js) because a
  // failure mid-way leaves it unrecorded and it is retried next boot.
  for (const statement of splitStatements(migration.sql)) {
    await pool.query(statement);
  }
  await ledger.recordMigration(pool, {
    version: migration.version,
    checksum: migration.checksum,
    kind: migration.kind,
    executionMs: elapsedMs(started),
  });
}

/**
 * @param {import('pg').Pool} pool
 * @param {object} [options]
 * @param {string} [options.migrationsDir]  where forward migrations live
 * @param {string} [options.baselineChecksum]  if given, refresh the baseline sentinel
 * @param {number} [options.baselineMs]  baseline apply duration for the ledger
 * @param {{log:Function, warn:Function, error:Function}} [options.logger]
 * @returns {Promise<{applied:string[], skipped:string[], drift:string[], orphaned:string[]}>}
 */
async function runMigrations(pool, options = {}) {
  const {
    migrationsDir = require('node:path').join(__dirname, '..', 'migrations'),
    baselineChecksum = null,
    baselineMs = null,
    logger = console,
  } = options;

  await ledger.ensureLedger(pool);

  if (baselineChecksum) {
    await ledger.recordBaseline(pool, { checksum: baselineChecksum, executionMs: baselineMs });
  }

  const applied = await ledger.getApplied(pool);
  const migrations = loadMigrations(migrationsDir);

  const result = { applied: [], skipped: [], drift: [], orphaned: [] };

  const onDisk = new Set(migrations.map((m) => m.version));
  for (const version of applied.keys()) {
    if (!onDisk.has(version)) result.orphaned.push(version);
  }
  if (result.orphaned.length) {
    logger.log(
      `[migrate] ${result.orphaned.length} applied migration(s) no longer on disk `
      + `(squashed into baseline?): ${result.orphaned.join(', ')}`,
    );
  }

  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      const prior = applied.get(migration.version);
      if (prior.checksum !== migration.checksum) {
        result.drift.push(migration.version);
        logger.warn(
          `[migrate] WARNING: checksum drift on already-applied migration `
          + `"${migration.filename}". The file changed after it was applied; the new `
          + `content was NOT executed. Migrations must be immutable once applied — `
          + `add a new migration instead of editing this one.`,
        );
      }
      result.skipped.push(migration.version);
      continue;
    }

    logger.log(
      `[migrate] applying ${migration.filename}`
      + `${migration.noTransaction ? ' (no-transaction)' : ''}`,
    );
    try {
      if (migration.noTransaction) {
        await applyWithoutTransaction(pool, migration);
      } else {
        await applyInTransaction(pool, migration);
      }
    } catch (err) {
      err.message = `[migrate] Migration "${migration.filename}" failed: ${err.message}`;
      throw err;
    }
    result.applied.push(migration.version);
  }

  if (result.applied.length) {
    logger.log(`[migrate] applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`);
  } else if (migrations.length) {
    logger.log(`[migrate] all ${migrations.length} migration(s) already applied.`);
  }

  return result;
}

module.exports = { runMigrations };
