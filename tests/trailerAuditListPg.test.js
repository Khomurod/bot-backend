/**
 * PostgreSQL integration — audit list pagination (§10). A paged request returns
 * the standard envelope; an unpaged request keeps the legacy bounded array.
 *
 * Requires TEST_DATABASE_URL.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

const POOL_PATH = require.resolve('../database/pool');

function loadAudit(harness) {
  const dbDir = path.resolve(__dirname, '../database');
  const purge = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) purge(full);
      else if (entry.name.endsWith('.js')) delete require.cache[full];
    }
  };
  purge(dbDir);
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true,
    exports: { pool: harness.pool, query: (t, v) => harness.pool.query(t, v), ping: async () => true },
  };
  return require('../database/trailerAudit');
}

test('audit list pages with the standard envelope and filters by entity type', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const audit = loadAudit(harness);
  for (let i = 0; i < 4; i += 1) {
    await audit.insertTrailerAudit({
      action: 'trailer.update', entityType: 'trailer', entityId: i + 1, newValues: { i },
    });
  }
  await audit.insertTrailerAudit({ action: 'payment.create', entityType: 'payment', entityId: 9 });

  const paged = await audit.listTrailerAudit({ page: 1, page_size: 3 });
  assert.equal(paged.total, 5);
  assert.equal(paged.items.length, 3);
  assert.equal(paged.page_size, 3);

  const filtered = await audit.listTrailerAudit({ entityType: 'trailer', page: 1, page_size: 25 });
  assert.equal(filtered.total, 4);

  const legacy = await audit.listTrailerAudit({});
  assert.ok(Array.isArray(legacy), 'legacy callers still get a bare array');
  assert.equal(legacy.length, 5);
});
