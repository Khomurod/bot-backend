/**
 * Pure combobox filter + company-defaults helpers (§1). Backs the searchable
 * company/trailer pickers and the auto-applied company defaults.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = path.resolve(__dirname, '../admin/src/pages/trailer/a11y/comboboxFilter.js');
let m;
test.before(async () => { m = await import(pathToFileURL(MODULE).href); });

const OPTS = [
  { value: '1', label: 'Acme Logistics', hint: 'Jane' },
  { value: '2', label: 'Globex Freight', hint: 'Bob' },
  { value: '3', label: 'Acme Rentals', hint: 'Sue' },
];

test('filterByText matches label case-insensitively', () => {
  assert.equal(m.filterByText(OPTS, 'acme', (o) => o.label).length, 2);
  assert.equal(m.filterByText(OPTS, 'globex', (o) => o.label).length, 1);
  assert.equal(m.filterByText(OPTS, '', (o) => o.label).length, 3);
  assert.equal(m.filterByText(OPTS, 'zzz', (o) => o.label).length, 0);
});

test('filterByText can search the hint too', () => {
  assert.equal(m.filterByText(OPTS, 'jane', (o) => `${o.label} ${o.hint}`).length, 1);
});

test('companyDefaults returns only defined fields', () => {
  const d = m.companyDefaults({
    contact_name: 'Jane', payment_terms: 'Net 30', billing_timezone: 'America/Chicago',
    payment_grace_period_days: 5, default_daily_rate: 120,
  });
  assert.deepEqual(d, {
    contact_name: 'Jane', payment_terms: 'Net 30', billing_timezone: 'America/Chicago',
    payment_grace_period_days: 5, default_daily_rate: 120,
  });
});

test('companyDefaults omits null/empty so it never blanks a field', () => {
  const d = m.companyDefaults({ contact_name: 'Jane', payment_terms: '', billing_timezone: null });
  assert.deepEqual(d, { contact_name: 'Jane' });
  assert.deepEqual(m.companyDefaults(null), {});
});

test('trailerPickerOptions excludes trailers chosen in other rows but keeps this row', () => {
  const trailers = [
    { id: 1, unit_number: '1045', type: 'reefer' },
    { id: 2, unit_number: '1088', type: 'dry' },
    { id: 3, unit_number: '2044' },
  ];
  // Row currently on trailer 1, with trailer 2 taken by another row.
  const opts = m.trailerPickerOptions(trailers, '1', ['2']);
  const values = opts.map((o) => o.value).sort();
  assert.deepEqual(values, ['1', '3']); // 2 excluded, 1 (own) kept
  // Nothing taken → all offered.
  assert.equal(m.trailerPickerOptions(trailers, '', []).length, 3);
});
