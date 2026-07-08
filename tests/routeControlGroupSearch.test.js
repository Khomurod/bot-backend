/**
 * Unit tests for the Route Control searchable driver-group dropdown logic
 * (admin/src/pages/routeControlGroupSearch.mjs). No React/DOM needed — the
 * option-building + live-filter functions are pure. Imported dynamically since
 * the source is ESM.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MOD = path.resolve(__dirname, '../admin/src/pages/routeControlGroupSearch.mjs');

const PROFILES = [
  { group_id: 1, group_name: 'WENZE UNIT 800 DILSHOD URINOV', unit_number: '800', first_name: 'Dilshod', last_name: 'Urinov', driver_type: 'company_driver' },
  { group_id: 2, group_name: 'WENZE UNIT 801 JOHN SMITH', unit_number: '801', first_name: 'John', last_name: 'Smith', driver_type: 'owner' },
  { group_id: 3, group_name: 'Random Group', full_name: 'Alex Ray', unit_number: null, driver_type: null },
];

test('buildGroupOptions produces a clean label and a search haystack', async () => {
  const { buildGroupOptions } = await import(MOD);
  const opts = buildGroupOptions(PROFILES);
  assert.equal(opts[0].label, 'Unit #800 — Dilshod Urinov — Company Driver');
  assert.equal(opts[1].label, 'Unit #801 — John Smith — Owner Operator');
  assert.equal(opts[2].label, 'Alex Ray'); // no unit → name only
  assert.ok(opts[0].search.includes('800'));
  assert.ok(opts[0].search.includes('dilshod'));
  assert.equal(opts[0].groupId, 1);
});

test('filterGroupOptions matches by driver name', async () => {
  const { buildGroupOptions, filterGroupOptions } = await import(MOD);
  const opts = buildGroupOptions(PROFILES);
  const r = filterGroupOptions(opts, 'dilshod');
  assert.equal(r.length, 1);
  assert.equal(r[0].groupId, 1);
});

test('filterGroupOptions matches by unit number', async () => {
  const { buildGroupOptions, filterGroupOptions } = await import(MOD);
  const opts = buildGroupOptions(PROFILES);
  const r = filterGroupOptions(opts, '801');
  assert.equal(r.length, 1);
  assert.equal(r[0].groupId, 2);
});

test('filterGroupOptions matches by group title', async () => {
  const { buildGroupOptions, filterGroupOptions } = await import(MOD);
  const opts = buildGroupOptions(PROFILES);
  const r = filterGroupOptions(opts, 'random');
  assert.equal(r.length, 1);
  assert.equal(r[0].groupId, 3);
});

test('filterGroupOptions matches by driver type', async () => {
  const { buildGroupOptions, filterGroupOptions } = await import(MOD);
  const opts = buildGroupOptions(PROFILES);
  const r = filterGroupOptions(opts, 'company');
  assert.equal(r.length, 1);
  assert.equal(r[0].groupId, 1);
});

test('filterGroupOptions AND-matches multiple tokens', async () => {
  const { buildGroupOptions, filterGroupOptions } = await import(MOD);
  const opts = buildGroupOptions(PROFILES);
  assert.equal(filterGroupOptions(opts, '800 dilshod').length, 1);
  assert.equal(filterGroupOptions(opts, '800 smith').length, 0); // no row has both
});

test('an empty query returns all options', async () => {
  const { buildGroupOptions, filterGroupOptions } = await import(MOD);
  const opts = buildGroupOptions(PROFILES);
  assert.equal(filterGroupOptions(opts, '').length, 3);
});
