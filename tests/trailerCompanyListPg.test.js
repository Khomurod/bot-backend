/**
 * PostgreSQL integration — company list search + server pagination (§5, §10).
 * A paged request returns { items, page, page_size, total }; an unpaged request
 * keeps the legacy bare array (the wizard picker depends on it).
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

function loadCompanies(harness) {
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
  return require('../database/trailerCompanies');
}

async function seed(harness) {
  for (const [name, active] of [['Acme Logistics', true], ['Globex Freight', true], ['Initech Hauling', false]]) {
    await harness.query(
      'INSERT INTO trailer_renter_companies (legal_name, display_name, active) VALUES ($1,$1,$2)',
      [name, active],
    );
  }
}

test('paged companies return the standard envelope; unpaged stays a bare array', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const companies = loadCompanies(harness);
  await seed(harness);

  const paged = await companies.listTrailerCompanies({ page: 1, page_size: 2 });
  assert.equal(paged.total, 3);
  assert.equal(paged.items.length, 2);
  assert.equal(paged.page_size, 2);

  const legacy = await companies.listTrailerCompanies({});
  assert.ok(Array.isArray(legacy), 'legacy callers still get a bare array');
  assert.equal(legacy.length, 3);
});

test('search and active filters narrow the paged result', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const companies = loadCompanies(harness);
  await seed(harness);

  const byName = await companies.listTrailerCompanies({ page: 1, page_size: 25, q: 'globex' });
  assert.equal(byName.total, 1);
  assert.equal(byName.items[0].display_name, 'Globex Freight');

  const archived = await companies.listTrailerCompanies({ page: 1, page_size: 25, active: false });
  assert.equal(archived.total, 1);
  assert.equal(archived.items[0].display_name, 'Initech Hauling');
});
