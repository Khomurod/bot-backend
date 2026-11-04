'use strict';

/**
 * lib/appSecrets/envFile.js — the .env reader behind Settings → Secrets. It
 * reads what Coolify and Render produce and what a person types, and NEVER
 * puts a value into a problem it reports.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEnvText } = require('../lib/appSecrets/envFile');

const asMap = (r) => Object.fromEntries(r.entries.map((e) => [e.name, e.value]));

test('plain, quoted, exported and commented lines', () => {
  const r = parseEnvText([
    '# a comment',
    '',
    'PLAIN=abc123',
    'export EXPORTED=yes',
    'DOUBLE="two words"',
    "SINGLE='it''s'",
    'ESCAPED="line1\\nline2 \\"q\\""',
    'TRAILING=value # note',
    'HASH_INSIDE=a#b',
    'EMPTY=',
    'URL=postgres://u:p@h:5432/db?sslmode=require',
  ].join('\n'));
  const m = asMap(r);
  assert.equal(m.PLAIN, 'abc123');
  assert.equal(m.EXPORTED, 'yes');
  assert.equal(m.DOUBLE, 'two words');
  assert.equal(m.ESCAPED, 'line1\nline2 "q"');
  assert.equal(m.TRAILING, 'value');
  assert.equal(m.HASH_INSIDE, 'a#b');
  assert.equal(m.EMPTY, '');
  assert.equal(m.URL, 'postgres://u:p@h:5432/db?sslmode=require');
  // 'it''s' is a quoted 'it' followed by more text — refused, not guessed.
  assert.equal(m.SINGLE, undefined);
  assert.equal(r.problems.length, 1);
});

test('only \\n, \\" and \\\\ are escapes; any other backslash is kept as written', () => {
  const m = asMap(parseEnvText('A="a\\sb"\nB="C:\\tmp\\x"\nC="x\\\\y"\n'));
  assert.equal(m.A, 'a\\sb');
  assert.equal(m.B, 'C:\\tmp\\x');
  assert.equal(m.C, 'x\\y');
});

test('Windows line endings and a byte-order mark', () => {
  const m = asMap(parseEnvText('﻿A=1\r\nB=2\r\n'));
  assert.deepEqual(m, { A: '1', B: '2' });
});

test('a name given twice keeps its last value and is reported', () => {
  const r = parseEnvText('A=1\nA=2\n');
  assert.deepEqual(asMap(r), { A: '2' });
  assert.deepEqual(r.duplicates, ['A']);
});

test('bad lines are reported by line number and name — never with the value', () => {
  const secret = 'sk-very-secret-value-123';
  const r = parseEnvText([
    `lower_case=${secret}`,
    `just text ${secret}`,
    `OPEN="${secret}`,
    `AFTER="x" ${secret}`,
  ].join('\n'));
  assert.equal(r.entries.length, 0);
  assert.deepEqual(r.problems.map((p) => p.line), [1, 2, 3, 4]);
  assert.ok(!JSON.stringify(r.problems).includes(secret));
});
