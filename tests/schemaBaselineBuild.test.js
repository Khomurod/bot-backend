/**
 * Guards the generated baseline: database/schema.sql MUST equal the assembly of
 * database/baseline/*.sql. schema.sql is what the app applies on boot and what
 * several tests + the docs generator read; the segment files are its source.
 * If they drift (someone edited a segment without running `npm run build:schema`,
 * or hand-edited schema.sql), this fails so the mistake is caught before boot.
 *
 * Pure filesystem checks — no database required.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { assemble, segmentFiles, SCHEMA_PATH } = require('../scripts/build-schema');

test('database/schema.sql is up to date with database/baseline/*.sql', () => {
  const current = fs.readFileSync(SCHEMA_PATH, 'utf8');
  assert.equal(
    current, assemble(),
    'database/schema.sql is stale. Run `npm run build:schema` and commit the result.',
  );
});

test('baseline segments are contiguously and uniquely numbered', () => {
  const files = segmentFiles();
  assert.ok(files.length >= 2, 'expected multiple baseline segments');
  const numbers = files.map((f) => Number(f.slice(0, f.indexOf('_'))));
  for (let i = 0; i < numbers.length; i += 1) {
    assert.equal(numbers[i], i + 1, `segment ${files[i]} is out of sequence`);
  }
});

test('assembled schema preserves the trailer-department section marker', () => {
  const assembled = assemble();
  const marker = '-- TRAILER DEPARTMENT: RENTAL + ASSET MANAGEMENT';
  const count = assembled.split(marker).length - 1;
  assert.equal(count, 1, 'the department section marker must appear exactly once (harness slices on it)');
});

test('assembled schema is pure concatenation (no segment adds a stray body header)', () => {
  // Each segment except the first must NOT start with the generated file header
  // banner — that banner lives only once, prepended by the builder.
  const files = segmentFiles();
  const fsMod = require('node:fs');
  const path = require('node:path');
  const dir = require('../scripts/build-schema').BASELINE_DIR;
  for (const f of files) {
    const body = fsMod.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!body.includes('GENERATED FILE — DO NOT EDIT'), `${f} unexpectedly contains the generated header`);
  }
});
