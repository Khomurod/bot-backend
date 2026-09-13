/**
 * CSV formula-injection safety (§10). A cell starting with = + - @ (or tab/CR)
 * must be neutralized so spreadsheets don't execute it on open.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { csvCell, toCsv, csvRows } = require('../server/routes/csvSafe');

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
  // CRLF, per RFC 4180 and per what the only real export in this application
  // already produced. The two implementations disagreed about this before they
  // were merged into one; the browser's was right and is what Excel expects.
  const [header, row] = csv.split('\r\n');
  assert.equal(header, 'name,note');
  assert.ok(row.includes(`"'=HYPERLINK`), 'the formula cell is neutralized');
});

test('toCsv on empty input yields just an empty header line', () => {
  assert.equal(toCsv([]), '');
});

/**
 * THE EXPORT THAT ACTUALLY EXISTS USES THIS.
 *
 * `csvSafe` was written, tested, and had no caller at all, while the one CSV
 * this application produces — Settings → Bot Group Access — carried its own
 * copy that quoted per RFC 4180 and stopped there. A guard that is proved and
 * then not used is not a guard, so the wiring is asserted here rather than
 * left to be noticed again.
 */
test('the Bot Group Access export builds its CSV with THIS module', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const panel = fs.readFileSync(
    path.resolve(__dirname, '../admin/src/pages/settings/bot/GroupAccessPanel.jsx'), 'utf8',
  );
  assert.match(panel, /from "\.\.\/\.\.\/\.\.\/utils\/csvSafe\.js"/);
  assert.match(panel, /csvRows\(\[headers, \.\.\.rows\]\)/);
  // And it no longer carries a private one. A local `csvCell` here is how the
  // hole came back the first time.
  assert.equal(/const csvCell\s*=/.test(panel), false,
    'a second CSV serialiser in the panel is the hole reopening');
});

test('a group title chosen by somebody else cannot become a formula', () => {
  // driver_name is read out of a TELEGRAM GROUP TITLE — anyone who can rename
  // that group picks it. These are the payloads that matter.
  for (const hostile of [
    '=HYPERLINK("http://example.invalid","click")',
    '+1+1',
    '-2+3',
    '@SUM(A1:A9)',
    '\tcmd',
    '\r=1',
  ]) {
    const cell = csvCell(hostile);
    assert.equal(cell.replace(/^"/, '').startsWith("'"), true,
      `not neutralised: ${JSON.stringify(hostile)} -> ${JSON.stringify(cell)}`);
  }
});

test('csvRows keeps the caller\'s own header row and neutralises every cell', () => {
  const out = csvRows([['Driver', 'Unit'], ['=EVIL()', '310'], ['Ordinary Name', '001']]);
  const lines = out.split('\r\n');
  assert.equal(lines[0], 'Driver,Unit');
  assert.equal(lines[1], "'=EVIL(),310");
  assert.equal(lines[2], 'Ordinary Name,001');
});
