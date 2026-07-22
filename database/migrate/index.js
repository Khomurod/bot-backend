'use strict';

/**
 * Public entry point for the database migration system.
 *
 * Architecture (see docs/database/migration-notes.md):
 *   - database/schema.sql        the BASELINE — the full, idempotent, accumulated
 *                                schema. Applied verbatim on every boot. Generated
 *                                from the organized segments in database/baseline/.
 *   - database/migrations/       FORWARD migrations — versioned, run-once, tracked
 *                                in the schema_migrations ledger. Where all NEW
 *                                schema/seed/backfill changes go.
 *   - database/migrate/          this runner: ledger + loader + apply loop.
 *
 * database/db.js → initializeDatabase() applies the baseline and then calls
 * runMigrations() to apply any pending forward migrations.
 */
const path = require('node:path');
const { runMigrations } = require('./runner');
const { loadMigrations } = require('./loader');
const { checksum } = require('./checksum');
const ledger = require('./ledger');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const BASELINE_PATH = path.join(__dirname, '..', 'schema.sql');

module.exports = {
  runMigrations,
  loadMigrations,
  checksum,
  ledger,
  MIGRATIONS_DIR,
  BASELINE_PATH,
  BASELINE_VERSION: ledger.BASELINE_VERSION,
};
