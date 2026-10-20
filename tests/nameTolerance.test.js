'use strict';

/**
 * lib/drivers/nameTolerance.js — the forgiving "same driver?" used where the
 * field is already one truck or one chat. Every pair below is a real one from
 * the owner's review of 20 October 2026: the first three were wrongly kept
 * apart, the rest are genuinely different people and must stay apart.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { namesLikelySame, oneEditApart } = require('../lib/drivers/nameTolerance');
const { driverNamesMatch } = require('../lib/drivers/driverGroupTitle');

test('the three near misses that blocked a correct link now agree', () => {
  assert.equal(namesLikelySame('CHARLIE ONEAL', "Charlie O'Neal Jr"), true, 'an apostrophe joins a name');
  assert.equal(namesLikelySame('CHARLIE ONEAL', 'Charlie O’Neal Jr'), true, 'the typographic apostrophe too');
  assert.equal(namesLikelySame('TERRENCE NESBIT', 'TERENCE NESBITT'), true, 'one letter off in each name');
  assert.equal(namesLikelySame('PRINCE BURTON', 'PRINCE / OTIS'), true, 'a team label naming the driver');
});

test('the strict matcher is untouched — the board still runs on it', () => {
  assert.equal(driverNamesMatch('TERRENCE NESBIT', 'TERENCE NESBITT'), false);
  assert.equal(driverNamesMatch('PRINCE BURTON', 'PRINCE / OTIS'), false);
});

test('a different person is still a different person', () => {
  for (const [a, b] of [
    ['JAVOKHIR ISLOMOV', 'TORREY SWATT'],
    ['OMAR ALAWAD', 'ZULKUFLIDDIN CHORIEV'],
    ['AZAMAT OTAMURADOV', 'DAMARION WHITLOCK'],
    ['NEWAY GEBREMARIAM', 'ZAKY GEBREYESUS'],
    ['RUSLAN ABDULLAEV', '266116 ABDI SALAH / SADIQ AHMED'],
    ['JOHN SMITH', 'MARK / PETE'],
  ]) {
    assert.equal(namesLikelySame(a, b), false, `${a} vs ${b}`);
  }
});

test('a typo must be in BOTH names, and only in names of four letters or more', () => {
  assert.equal(namesLikelySame('TERRENCE NESBIT', 'TERRENCE JONES'), false, 'a shared first name is not enough');
  assert.equal(namesLikelySame('TERRENCE NESBIT', 'TORRANCE NESBITT'), false, 'two letters off is not one');
  assert.equal(namesLikelySame('ABEL NESBIT', 'ABEL NESBOT'), true);
  assert.equal(namesLikelySame('BEN COX', 'BEX COY'), false, 'three-letter names are too short to forgive a letter');
});

test('nothing matches an empty name', () => {
  assert.equal(namesLikelySame('', 'PRINCE / OTIS'), false);
  assert.equal(namesLikelySame('PRINCE BURTON', ''), false);
  assert.equal(namesLikelySame('PRINCE BURTON', ' / '), false);
});

test('one edit: insert, delete or replace a single letter', () => {
  assert.equal(oneEditApart('nesbit', 'nesbitt'), true);
  assert.equal(oneEditApart('terence', 'terrence'), true);
  assert.equal(oneEditApart('smith', 'smyth'), true);
  assert.equal(oneEditApart('smith', 'smiths'), true);
  assert.equal(oneEditApart('smith', 'smythe'), false);
  assert.equal(oneEditApart('abc', 'cba'), false);
});
