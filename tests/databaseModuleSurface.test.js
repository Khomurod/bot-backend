/**
 * Smoke test for the database layer's module surface.
 *
 * This is a low-cost safety net that guards the *structure* of `database/`,
 * not its query logic. It exists to make the future consolidation described in
 * docs/architecture/module-map.md safe to perform:
 *
 *   - Every `database/*.js` module must load without throwing. This instantly
 *     catches a broken `require`, a dangling reference, or a **circular
 *     dependency** — the specific risk of moving query functions out of the
 *     3,500-line `database/db.js` into the per-feature modules (each of which
 *     already does `require('./db')` for the shared `query`/pool seam).
 *   - `database/db.js` must keep exposing the shared `query`/`pool`/`ping`
 *     seam that every sibling module and service depends on, plus a large
 *     export surface (guards against an accidental mass-removal of helpers).
 *
 * It intentionally does NOT assert individual helper names, so adding or
 * renaming a single function does not make it brittle.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Minimal env so requiring the modules (which construct a pg Pool object but do
// not connect) does not blow up. Mirrors the other HTTP/db tests.
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.BOT_TOKEN ||= 'test-bot-token';

const DB_DIR = path.resolve(__dirname, '../database');

function databaseModuleFiles() {
  return fs
    .readdirSync(DB_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort();
}

test('every database/*.js module loads without throwing (catches circular deps / broken requires)', () => {
  const files = databaseModuleFiles();
  assert.ok(files.length >= 5, `expected several database modules, found ${files.length}`);

  for (const file of files) {
    const modulePath = path.join(DB_DIR, file);
    let mod;
    assert.doesNotThrow(() => {
      mod = require(modulePath);
    }, `database/${file} should load without throwing`);
    assert.equal(typeof mod, 'object', `database/${file} should export an object`);

    const exportedFns = Object.values(mod).filter((v) => typeof v === 'function');
    assert.ok(
      exportedFns.length >= 1,
      `database/${file} should export at least one function`,
    );
  }
});

test('database/db.js keeps the shared query/pool/ping seam that every module depends on', () => {
  const db = require(path.join(DB_DIR, 'db.js'));

  assert.equal(typeof db.query, 'function', 'db.query must remain a function');
  assert.equal(typeof db.ping, 'function', 'db.ping must remain a function');
  assert.equal(typeof db.initializeDatabase, 'function', 'db.initializeDatabase must remain a function');
  assert.ok(db.pool && typeof db.pool === 'object', 'db.pool must remain exported');

  // The monolith exposes a large helper surface today. A sudden collapse of
  // that surface almost certainly means an accidental deletion during a move.
  const exportedNames = Object.keys(db);
  assert.ok(
    exportedNames.length >= 100,
    `db.js export surface unexpectedly small (${exportedNames.length}); did a move drop helpers?`,
  );
});

test('per-feature database modules resolve the shared seam via db.js (no duplicate pool)', () => {
  // Each feature module imports { query } from ./db. Loading db.js first and
  // then a feature module must not throw or hang — the canonical circular-dep
  // failure mode. homeTime.js is a representative importer.
  const db = require(path.join(DB_DIR, 'db.js'));
  const homeTime = require(path.join(DB_DIR, 'homeTime.js'));
  assert.equal(typeof db.query, 'function');
  assert.equal(typeof homeTime, 'object');
  assert.ok(
    Object.values(homeTime).some((v) => typeof v === 'function'),
    'homeTime.js should export helpers built on the shared query seam',
  );
});
