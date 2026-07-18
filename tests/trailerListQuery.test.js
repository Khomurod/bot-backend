/**
 * Pure URL list-state + pagination helpers (§2, §10, §17): parse/serialize,
 * page math, active-filter count, and page reset on filter change.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = path.resolve(__dirname, '../admin/src/pages/trailer/a11y/listQuery.js');
let m;
test.before(async () => { m = await import(pathToFileURL(MODULE).href); });

test('totalPages rounds up and is at least 1', () => {
  assert.equal(m.totalPages(0, 25), 1);
  assert.equal(m.totalPages(25, 25), 1);
  assert.equal(m.totalPages(26, 25), 2);
  assert.equal(m.totalPages(250, 25), 10);
});

test('activeFilterCount ignores paging keys and empty values', () => {
  assert.equal(m.activeFilterCount({ page: 2, page_size: 25 }), 0);
  assert.equal(m.activeFilterCount({ q: 'abc', physicalStatus: '', needs_attention: false, page: 1 }), 1);
  assert.equal(m.activeFilterCount({ q: 'a', company: 'Acme', missing_location: 'true' }), 3);
});

test('parse only keeps allowed keys and coerces paging to numbers', () => {
  const parsed = m.parseListParams('q=1045&physicalStatus=available&page=3&page_size=50&evil=x', ['q', 'physicalStatus', 'page', 'page_size']);
  assert.deepEqual(parsed, { q: '1045', physicalStatus: 'available', page: 3, page_size: 50 });
  assert.equal(parsed.evil, undefined);
});

test('serialize drops empty/false values', () => {
  const qs = m.serializeListParams({ q: 'x', physicalStatus: '', needs_attention: false, page: 2 });
  const params = new URLSearchParams(qs);
  assert.equal(params.get('q'), 'x');
  assert.equal(params.get('page'), '2');
  assert.equal(params.has('physicalStatus'), false);
  assert.equal(params.has('needs_attention'), false);
});

test('changing a filter resets to page 1', () => {
  assert.deepEqual(m.withFilterChange({ q: 'a', page: 5, page_size: 25 }, { physicalStatus: 'available' }),
    { q: 'a', page: 1, page_size: 25, physicalStatus: 'available' });
});

test('parse then serialize round-trips a filter set', () => {
  const allowed = ['q', 'company', 'page', 'page_size'];
  const qs = m.serializeListParams({ q: 'acme', company: 'Globex', page: 2, page_size: 25 });
  assert.deepEqual(m.parseListParams(qs, allowed), { q: 'acme', company: 'Globex', page: 2, page_size: 25 });
});
