'use strict';

/**
 * The Board's `row` is a spreadsheet POSITION. Insert one line and every row
 * below it renumbers while nothing about those drivers changed — so the
 * snapshot is keyed on the truck and the person instead, through the same
 * normalizers a Telegram group title already goes through.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { boardRowKey } = require('../lib/board/rowKey');

test('two spellings of one row produce one key', () => {
  const a = boardRowKey({ truckRaw: '001', cleanName: 'JOHN SMITH' });
  const b = boardRowKey({ truckRaw: '#001', cleanName: 'John  Smith' });
  assert.equal(a, b);
});

test('a team is named by both people, in either order', () => {
  const typed = boardRowKey({ truckRaw: '7', cleanName: 'A ONE / B TWO', teamMembers: ['A ONE', 'B TWO'] });
  const retyped = boardRowKey({ truckRaw: '7', cleanName: 'B TWO / A ONE', teamMembers: ['B TWO', 'A ONE'] });
  assert.equal(typed, retyped, 'reordering the pair must not create a second row');
});

test('the key keeps the trucks apart that the fleet keeps apart', () => {
  const zeros = boardRowKey({ truckRaw: '001', cleanName: 'JOHN SMITH' });
  const plain = boardRowKey({ truckRaw: '1', cleanName: 'JOHN SMITH' });
  assert.notEqual(zeros, plain);
});

test('two people on one truck are two rows', () => {
  const one = boardRowKey({ truckRaw: '001', cleanName: 'JOHN SMITH' });
  const other = boardRowKey({ truckRaw: '001', cleanName: 'JANE DOE' });
  assert.notEqual(one, other);
});

test('a row naming neither a truck nor a person cannot be tracked', () => {
  assert.equal(boardRowKey({ truckRaw: '', cleanName: '' }), null);
  assert.equal(boardRowKey({}), null);
  assert.equal(boardRowKey(null), null);
});

test('half a row still gets a key, so it is visible rather than dropped', () => {
  assert.equal(boardRowKey({ truckRaw: '', cleanName: 'JOHN SMITH' }), '?|john smith');
  assert.equal(boardRowKey({ truckRaw: '001', cleanName: '' }), '001|?');
});
