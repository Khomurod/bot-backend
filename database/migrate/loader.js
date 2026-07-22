'use strict';

/**
 * Discover and parse forward migrations from database/migrations/.
 *
 * A forward migration is a single `.sql` file named `NNNN_snake_description.sql`
 * where `NNNN` is a zero-padded, strictly increasing integer that fixes the
 * apply order. Files are applied in ascending filename order — the numeric
 * prefix is the version, so lexical order equals intended order.
 *
 * Optional per-file directives (SQL line comments anywhere in the file, but by
 * convention in a header block):
 *
 *   -- migrate:no-transaction     → apply WITHOUT wrapping BEGIN/COMMIT. Required
 *                                    for statements Postgres forbids inside a
 *                                    transaction (CREATE INDEX CONCURRENTLY,
 *                                    ALTER TYPE ... ADD VALUE, …). Such a
 *                                    migration MUST be internally idempotent
 *                                    because a mid-way failure leaves it
 *                                    unrecorded and it will be retried on the
 *                                    next boot.
 *   -- migrate:kind: <schema|seed|backfill>
 *                                    → informational; recorded in the ledger so
 *                                      the change's intent is queryable. Defaults
 *                                      to 'schema'.
 *
 * The baseline (the accumulated, idempotent schema in database/schema.sql) is
 * NOT a forward migration and is not discovered here — it is applied every boot
 * by the runner and recorded separately.
 */
const fs = require('node:fs');
const path = require('node:path');
const { checksum } = require('./checksum');

const FILENAME_RE = /^(\d{4,})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;
const KIND_RE = /^--\s*migrate:kind:\s*(schema|seed|backfill)\s*$/im;
const NO_TXN_RE = /^--\s*migrate:no-transaction\s*$/im;
const VALID_KINDS = new Set(['schema', 'seed', 'backfill']);

/**
 * @param {string} migrationsDir absolute path to the migrations directory
 * @returns {Array<{version:string, filename:string, sql:string, checksum:string,
 *   noTransaction:boolean, kind:string}>} ordered ascending by numeric version
 */
function loadMigrations(migrationsDir) {
  let entries;
  try {
    entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const migrations = [];
  const seenVersions = new Map();

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.sql')) continue;

    const match = FILENAME_RE.exec(entry.name);
    if (!match) {
      throw new Error(
        `[migrate] Invalid migration filename "${entry.name}". `
        + 'Expected NNNN_snake_case_description.sql (e.g. 0001_add_widget_flags.sql).',
      );
    }

    const version = match[1];
    if (seenVersions.has(version)) {
      throw new Error(
        `[migrate] Duplicate migration version ${version}: `
        + `"${seenVersions.get(version)}" and "${entry.name}". Versions must be unique.`,
      );
    }
    seenVersions.set(version, entry.name);

    const sql = fs.readFileSync(path.join(migrationsDir, entry.name), 'utf8');
    if (!sql.trim()) {
      throw new Error(`[migrate] Migration "${entry.name}" is empty.`);
    }

    const kindMatch = KIND_RE.exec(sql);
    migrations.push({
      version,
      filename: entry.name,
      sql,
      checksum: checksum(sql),
      noTransaction: NO_TXN_RE.test(sql),
      kind: kindMatch && VALID_KINDS.has(kindMatch[1]) ? kindMatch[1] : 'schema',
    });
  }

  migrations.sort((a, b) => {
    // Numeric-aware compare on the version prefix; equal-length zero-padded
    // strings would sort fine lexically, but ragged widths (0009 vs 00010)
    // must not.
    const na = Number(a.version);
    const nb = Number(b.version);
    if (na !== nb) return na - nb;
    return a.filename < b.filename ? -1 : 1;
  });

  return migrations;
}

module.exports = { loadMigrations, FILENAME_RE };
