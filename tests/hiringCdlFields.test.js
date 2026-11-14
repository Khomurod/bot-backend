'use strict';

/**
 * lib/hiringStages/cdlFields.js — what a model's reading of a CDL may be
 * trusted to say (owner, 14 November 2026; docs/architecture/hiring-cdl-reading.md).
 * Every value is checked by type and DROPPED when it does not fit — never
 * repaired; a key the shape does not have is dropped; an unsure answer reads
 * as unsure. Every value here is made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { readCdlAnswer, realDate, ITEM_KEYS, cdlFullName } = require('../lib/hiringStages/cdlFields');

const TODAY = '2026-11-14';
const answer = (fields, over = {}) => ({
  is_cdl: true, front_photo: 1, back_photo: 2, unclear: false, confidence: 95, fields, ...over,
});
const read = (fields, over, photoCount = 3) => readCdlAnswer(answer(fields, over), { photoCount, today: TODAY });

test('a clean reading keeps every item, normalised', () => {
  const r = read({
    first_name: 'LEAH', middle_name: 'ANN', last_name: "O'BRIEN-SMITH", suffix: 'jr.',
    date_of_birth: '1988-02-29', address_street: '1200 MAIN ST APT 4', address_city: 'DALLAS',
    address_state: 'tx', address_zip: '752011234', license_number: 'a123-456 789', license_state: 'TX',
    license_class: 'CLASS A', issue_date: '2022-03-01', expiration_date: '2030-02-29'.replace('29', '28'),
    endorsements: 'h, n,t', restrictions: 'none', sex: 'female', height: "5'-06\"", weight: '140 lbs',
    eye_color: 'brown', hair_color: 'BLN',
  });
  assert.equal(r.status, 'read');
  assert.deepEqual(r.dropped, []);
  assert.deepEqual([r.front, r.back], [1, 2]);
  assert.deepEqual(r.values, {
    first_name: 'Leah', middle_name: 'Ann', last_name: "O'Brien-Smith", suffix: 'Jr',
    date_of_birth: '1988-02-29', address_street: '1200 MAIN ST APT 4', address_city: 'DALLAS',
    address_state: 'TX', address_zip: '75201-1234', license_number: 'A123-456789', license_state: 'TX',
    license_class: 'A', issue_date: '2022-03-01', expiration_date: '2030-02-28',
    endorsements: 'H N T', restrictions: 'NONE', sex: 'F', height: '5\'6"', weight: '140 lb',
    eye_color: 'BRO', hair_color: 'BLN',
  });
  assert.equal(cdlFullName(r.values), "Leah Ann O'Brien-Smith Jr");
  assert.equal(ITEM_KEYS.length, 21, 'everything printed on a CDL');
});

test('BAD DATES are dropped: not a calendar day, not the asked shape, out of range', () => {
  for (const bad of ['1987-02-29', '2001-13-01', '2001-04-31', '04/12/1988', '1988-4-12', '12 April 1988', '1850-01-01']) {
    assert.equal(realDate(bad), null, bad);
    const r = read({ first_name: 'KWAME', last_name: 'ASANTE', date_of_birth: bad });
    assert.equal(r.values.date_of_birth, undefined, bad);
    assert.ok(r.dropped.includes('date_of_birth'), bad);
  }
  assert.equal(realDate('2024-02-29'), '2024-02-29');
});

test('dates that contradict each other are BOTH dropped — which is wrong is not guessed', () => {
  let r = read({ first_name: 'KWAME', last_name: 'ASANTE', issue_date: '2031-01-01', expiration_date: '2030-01-01' });
  assert.equal(r.values.issue_date, undefined, 'an issue date in the future');
  r = read({ first_name: 'KWAME', last_name: 'ASANTE', issue_date: '2025-01-01', expiration_date: '2024-01-01' });
  assert.deepEqual([r.values.issue_date, r.values.expiration_date], [undefined, undefined]);
  r = read({ first_name: 'KWAME', last_name: 'ASANTE', date_of_birth: '2020-01-01' });
  assert.equal(r.values.date_of_birth, undefined, 'a six-year-old does not drive a truck');
  r = read({ first_name: 'KWAME', last_name: 'ASANTE', date_of_birth: '1990-01-01', issue_date: '1999-05-05' });
  assert.deepEqual([r.values.date_of_birth, r.values.issue_date], [undefined, undefined], 'a licence at nine');
});

test('WRONG SHAPES are dropped: licence, state, ZIP, class, sex, height, weight, colours, names', () => {
  const cases = {
    license_number: ['A1', 'ABC_123', '1234567890 1234567890 1', 'NODIGITS', '-12345', '123--45'],
    license_state: ['Texas', 'T', 'XX', 'TXX'],
    address_state: ['ZZ'],
    address_zip: ['7520', '752011', 'ABCDE'],
    license_class: ['CLASS ABC', 'A12', '1'],
    sex: ['Y', 'unknown'],
    height: ["9'-02\"", "5'-14\"", '300 cm', 'tall'],
    weight: ['40', '900 lb', 'heavy'],
    eye_color: ['purple', 'UNK'],
    hair_color: ['blue', 'UNK'],
    first_name: ['K4WAME', '', 'x'.repeat(41), '---'],
    address_city: ['DALLAS 75201'],
    endorsements: ['HAZMAT TANKER', 'H,N,T,X,P,S,A,B,C,D,E,F,G'],
    suffix: ['ESQ'],
  };
  for (const [key, values] of Object.entries(cases)) {
    for (const value of values) {
      const r = read({ first_name: 'KWAME', last_name: 'ASANTE', [key]: value });
      if (key === 'first_name' && value === '') {
        assert.equal(r.values.first_name, undefined);
        continue;
      }
      assert.equal(r.values[key], undefined, `${key}: ${value}`);
    }
  }
});

test('a value that is not a string is dropped; null and blank are simply absent', () => {
  const r = read({
    first_name: 'KWAME', last_name: 'ASANTE', weight: 180, license_class: ['A'], date_of_birth: null, sex: '  ',
  });
  assert.deepEqual(r.values, { first_name: 'Kwame', last_name: 'Asante' });
  assert.deepEqual(r.dropped.sort(), ['license_class', 'weight']);
});

test('EXTRA KEYS are dropped, never passed on', () => {
  const r = read({
    first_name: 'KWAME', last_name: 'ASANTE', ssn: '123-45-6789', donor: 'Y', organ_donor: 'YES',
  });
  assert.deepEqual(Object.keys(r.values).sort(), ['first_name', 'last_name']);
  assert.deepEqual(r.dropped, ['extra', 'extra', 'extra']);
});

test('which photo is the front and the back: real photo numbers, two different ones', () => {
  assert.equal(read({ first_name: 'KWAME', last_name: 'ASANTE' }, { front_photo: 4 }).status, 'not_cdl', 'only 3 photos');
  assert.equal(read({ first_name: 'KWAME', last_name: 'ASANTE' }, { front_photo: 0 }).status, 'not_cdl', 'numbers start at 1');
  assert.equal(read({ first_name: 'KWAME', last_name: 'ASANTE' }, { front_photo: '1' }).status, 'not_cdl');
  assert.equal(read({ first_name: 'KWAME', last_name: 'ASANTE' }, { back_photo: 1 }).back, null, 'the back is not the front');
  assert.equal(read({ first_name: 'KWAME', last_name: 'ASANTE' }, { back_photo: 9 }).back, null);
});

test('UNSURE, not a CDL, or no shape at all: nothing is kept', () => {
  assert.equal(read({ first_name: 'KWAME', last_name: 'ASANTE' }, { unclear: true }).status, 'unsure');
  assert.equal(read({ first_name: 'KWAME', last_name: 'ASANTE' }, { is_cdl: false }).status, 'not_cdl');
  assert.equal(read({ first_name: 'KWAME', last_name: 'ASANTE' }, { is_cdl: 'yes' }).status, 'not_cdl');
  for (const parsed of [null, 'text', [], { is_cdl: true, front_photo: 1, fields: [] }, { is_cdl: true, front_photo: 1 }]) {
    const r = readCdlAnswer(parsed, { photoCount: 2, today: TODAY });
    assert.equal(r.status, 'unreadable');
    assert.deepEqual(r.values, {});
  }
  assert.equal(read({ license_number: 'nonsense!!' }).status, 'unreadable', 'nothing valid left');
});
