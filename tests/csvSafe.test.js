/**
 * CSV formula-injection safety (§10). A cell starting with = + - @ (or tab/CR)
 * must be neutralized so spreadsheets don't execute it on open.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { csvCell, toCsv } = require('../server/routes/csvSafe');

test('formula-leading values are neutralized with a leading quote', () => {
  // No comma/quote/newline → neutralized but not RFC-4180 quoted.
  assert.equal(csvCell('=SUM(A1:A2)'), `'=SUM(A1:A2)`);
  assert.equal(csvCell('+1+1'), `'+1+1`);
  assert.equal(csvCell('-2-2'), `'-2-2`);
  assert.equal(csvCell('@cmd'), `'@cmd`);
  assert.equal(csvCell('\t=1'), `'\t=1`);
});

test('ordinary values are unchanged', () => {
  assert.equal(csvCell('Acme Logistics'), 'Acme Logistics');
  assert.equal(csvCell(1234), '1234');
  assert.equal(csvCell(null), '');
});

test('RFC-4180 quoting for commas, quotes and newlines still applies', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('she said "hi"'), '"she said ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
});

test('a formula value that also contains a comma is both neutralized and quoted', () => {
  assert.equal(csvCell('=1,2'), `"'=1,2"`);
});

test('toCsv emits a header row and neutralizes every cell', () => {
  const csv = toCsv([{ name: 'Acme', note: '=HYPERLINK("x")' }]);
  const [header, row] = csv.split('\n');
  assert.equal(header, 'name,note');
  assert.ok(row.includes(`"'=HYPERLINK`), 'the formula cell is neutralized');
});

test('toCsv on empty input yields just an empty header line', () => {
  assert.equal(toCsv([]), '');
});
