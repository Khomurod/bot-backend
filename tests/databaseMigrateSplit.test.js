/**
 * Unit — SQL statement splitter used for no-transaction migrations.
 * Pure logic, no database required.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitStatements } = require('../database/migrate/splitStatements');

test('splits simple statements on semicolons', () => {
  assert.deepEqual(splitStatements('SELECT 1; SELECT 2;'), ['SELECT 1', 'SELECT 2']);
});

test('ignores a trailing separator and blank statements', () => {
  assert.deepEqual(splitStatements('SELECT 1;;\n\n'), ['SELECT 1']);
});

test('does not split on a semicolon inside a single-quoted string', () => {
  assert.deepEqual(
    splitStatements("INSERT INTO t (s) VALUES ('a;b'); SELECT 1;"),
    ["INSERT INTO t (s) VALUES ('a;b')", 'SELECT 1'],
  );
});

test('handles doubled single-quote escapes', () => {
  assert.deepEqual(
    splitStatements("SELECT 'it''s; fine'; SELECT 2;"),
    ["SELECT 'it''s; fine'", 'SELECT 2'],
  );
});

test('does not split inside a dollar-quoted block', () => {
  const sql = 'DO $$ BEGIN IF TRUE THEN NULL; END IF; END $$; CREATE TABLE x (id INT);';
  assert.deepEqual(splitStatements(sql), [
    'DO $$ BEGIN IF TRUE THEN NULL; END IF; END $$',
    'CREATE TABLE x (id INT)',
  ]);
});

test('does not split on a semicolon inside a line comment', () => {
  const sql = 'SELECT 1; -- a; b; c\nSELECT 2;';
  assert.deepEqual(splitStatements(sql), ['SELECT 1', '-- a; b; c\nSELECT 2']);
});

test('does not split inside a block comment', () => {
  assert.deepEqual(
    splitStatements('SELECT 1 /* ; ; */ ; SELECT 2;'),
    ['SELECT 1 /* ; ; */', 'SELECT 2'],
  );
});

test('a single statement with no separator is returned whole', () => {
  assert.deepEqual(
    splitStatements('CREATE INDEX CONCURRENTLY idx ON t(a)'),
    ['CREATE INDEX CONCURRENTLY idx ON t(a)'],
  );
});
