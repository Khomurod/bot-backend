'use strict';

/**
 * Board ↔ Bitrix: when two names are the same driver, and how a truck number
 * is read out of a Bitrix "Trucks" title. The owner's rule (29 October 2026):
 * a letter or two, an extra space, or the other word order is the same person
 * and not worth a question; a bigger difference is.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const names = require('../lib/boardBitrix/names');
const { truckNumberFromTitle, sameTruckNumber } = require('../lib/boardBitrix/trucks');
const { readReply } = require('../lib/boardBitrix/replyIntent');
const { truckIdFromLink, fleetFromDriverType } = require('../lib/boardBitrix/vocabulary');

test('small differences are the same driver: word order, spaces, a letter or two, a fleet label', () => {
  for (const [a, b] of [
    ['OLABODE OLUDAISI ', 'OLUDAISI OLABODE'],
    ['TERENCE NESBITT', 'TERRENCE NESBIT'],
    ['ABDI NASIR', 'ABDINASIR'],
    ['JOHN SMITH (COMPANY DRIVER)', 'JOHN  SMITH'],
    ["Charlie O'Neal", 'CHARLIE ONEAL'],
    ['JOHN MICHAEL SMITH', 'JOHN SMITH'],
  ]) {
    assert.equal(names.namesClose(a, b), true, `${a} ~ ${b}`);
  }
});

test('a bigger difference is a different driver: short words get no typo allowance, one shared surname is not enough', () => {
  for (const [a, b] of [
    ['ALI HASSAN', 'ABU HASSAN'],
    ['JOHN SMITH', 'JANE SMITH'],
    ['TORREY SWATT', 'JAVOKHIR ISLOMOV'],
    ['SMITH', 'JOHN SMITH'],
    ['ALEXANDER PETROV', 'ALEXANDRA PETROVA'],
  ]) {
    assert.equal(names.namesClose(a, b), false, `${a} ≠ ${b}`);
  }
});

test('one word matches only on the same truck (namesCompatible), never across the fleet', () => {
  assert.equal(names.namesCompatible('ABDINASIR  ', 'ABDINASIR MOHAMED (LEASE DRIVER)'), true);
  assert.equal(names.namesClose('ABDINASIR', 'ABDINASIR MOHAMED'), false);
  assert.equal(names.namesCompatible('AL', 'AL HASSAN'), false, 'two letters is not a name');
  assert.equal(names.namesCompatible('IBRAHIM', 'ABDINASIR MOHAMED'), false);
});

test('the person key ignores word order, labels and spacing', () => {
  assert.equal(names.personKey('OLABODE  OLUDAISI (COMPANY DRIVER)'), names.personKey('oludaisi olabode'));
  assert.deepEqual(names.titleParts('Prince/Otis'), ['Prince', 'Otis']);
  assert.deepEqual(names.titleParts('ABDINASIR  '), ['ABDINASIR']);
});

test('truck numbers from the titles Bitrix really has, leading zeros kept; two bare numbers are unreadable', () => {
  const cases = {
    'Trucks #001': '001', 'Truck# 003': '003', 'Truck # 022': '022', 'Unit# 888': '888',
    '008': '008', 'Trucks #007 (USMON)': '007', 'Trucks # 016': '016', 'Truck 12A': '12A',
    '2024 Freightliner 310': null, '': null,
  };
  for (const [title, number] of Object.entries(cases)) assert.equal(truckNumberFromTitle(title), number, title);
});

test('the same truck number: exact, or the same digits with no letter; 001A is not 001', () => {
  assert.equal(sameTruckNumber('001', '1'), true);
  assert.equal(sameTruckNumber('#310', '310'), true);
  assert.equal(sameTruckNumber('001', '001A'), false);
  assert.equal(sameTruckNumber('310', '311'), false);
  assert.equal(sameTruckNumber(null, '1'), false);
});

test('a CRM link and the driver type, however Bitrix spells them', () => {
  for (const v of [3, '3', 'T418_3', ['3'], [3]]) assert.equal(truckIdFromLink(v), 3, JSON.stringify(v));
  for (const v of [null, '', [], 'abc', 0]) assert.equal(truckIdFromLink(v), null, JSON.stringify(v));
  assert.equal(fleetFromDriverType('361'), 'company');
  assert.equal(fleetFromDriverType(363), 'owner_operator');
  assert.equal(fleetFromDriverType(['395']), 'lease');
  assert.equal(fleetFromDriverType(''), null);
  assert.equal(fleetFromDriverType('999'), null);
});

test('the owner\'s reply: done in English or Russian, skip, and a negation is never "done"', () => {
  for (const s of ['done', 'Done!', 'fixed it', 'сделал', 'Готово', 'я поправил', 'исправила']) assert.equal(readReply(s), 'done', s);
  for (const s of ['skip', 'later', 'пропусти', 'позже']) assert.equal(readReply(s), 'skip', s);
  for (const s of ['not done yet', 'не сделал', 'hello', '', 'why?', "haven't fixed it yet", "isn't done", 'not fully done',
    'не всё готово', 'нет, не готово', 'I didn’t fix it', 'no']) {
    assert.equal(readReply(s), 'unclear', s);
  }
});
