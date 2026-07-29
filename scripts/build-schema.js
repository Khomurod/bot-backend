#!/usr/bin/env node
/**
 * Assemble database/schema.sql (the baseline) from the ordered segment files in
 * database/baseline/*.sql.
 *
 * schema.sql is a GENERATED artifact: the runtime applies it verbatim on every
 * boot (one transaction), and several tests + the docs generator read it. The
 * source of truth is the organized, per-domain segment files under
 * database/baseline/, which concatenate — in zero-padded filename order — to
 * exactly the schema body. This script is the one place that assembly happens.
 *
 *   node scripts/build-schema.js           # regenerate database/schema.sql
 *   node scripts/build-schema.js --check   # verify it is up to date (CI/tests)
 *
 * The assembly is a pure concatenation (segments joined by "\n"), so the applied
 * SQL is identical whether you run the segments or the assembled file.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_DIR = path.join(ROOT, 'database', 'baseline');
const SCHEMA_PATH = path.join(ROOT, 'database', 'schema.sql');

const HEADER = [
  '-- =============================================================================',
  '-- GENERATED FILE — DO NOT EDIT BY HAND.',
  '--',
  '-- Assembled from database/baseline/*.sql by scripts/build-schema.js.',
  '-- Edit the per-domain segment files there, then run: npm run build:schema',
  '--',
  '-- This is the BASELINE: the accumulated, additive, idempotent schema applied',
  '-- verbatim on every boot. NEW schema/seed/backfill changes are versioned,',
  '-- run-once forward migrations in database/migrations/ — see that folder\'s',
  '-- README and docs/database/migration-notes.md.',
  '-- =============================================================================',
  '',
  '',
].join('\n');

/** Ordered segment files. */
function segmentFiles() {
  const files = fs.readdirSync(BASELINE_DIR)
    .filter((f) => /^\d{3,}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  if (!files.length) throw new Error(`No baseline segments found in ${BASELINE_DIR}`);
  return files;
}

/**
 * Normalize line endings to LF.
 *
 * The header above is built in JS with '\n', but the segment BODIES are read
 * from disk — and on a Windows checkout (core.autocrlf) they arrive as CRLF.
 * Without this the assembled output was LF header + CRLF bodies, so the exact
 * bytes depended on which platform ran the build, and `--check` could never pass
 * on a CRLF working copy even though the SQL was identical. Normalizing makes
 * the generated file byte-identical on every platform, which is what lets CI
 * gate on it.
 */
function toLf(text) {
  return String(text).replace(/\r\n/g, '\n');
}

/** The assembled schema.sql content (header + concatenated segments), LF. */
function assemble() {
  const files = segmentFiles();
  const bodies = files.map((f) => toLf(fs.readFileSync(path.join(BASELINE_DIR, f), 'utf8')));
  return HEADER + bodies.join('\n');
}

function main() {
  const check = process.argv.includes('--check');
  const assembled = assemble();

  if (check) {
    const current = fs.existsSync(SCHEMA_PATH) ? fs.readFileSync(SCHEMA_PATH, 'utf8') : '';
    // Compare normalized: a developer on Windows has a CRLF working copy of a
    // file git stores as LF, and that is not schema drift. Content is what
    // matters here, so a spurious failure would just train people to ignore it.
    if (toLf(current) !== assembled) {
      console.error(
        '[build:schema] database/schema.sql is OUT OF DATE with database/baseline/*.sql.\n'
        + '               Run `npm run build:schema` and commit the result.',
      );
      process.exit(1);
    }
    console.log(`[build:schema] schema.sql is up to date (${segmentFiles().length} segments).`);
    return;
  }

  fs.writeFileSync(SCHEMA_PATH, assembled, 'utf8');
  console.log(`[build:schema] wrote database/schema.sql from ${segmentFiles().length} segments.`);
}

if (require.main === module) main();

module.exports = { assemble, segmentFiles, main, toLf, BASELINE_DIR, SCHEMA_PATH, HEADER };
