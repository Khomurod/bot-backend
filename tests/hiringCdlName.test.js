'use strict';

/**
 * lib/hiringStages/cdlName.js — is the CDL the post's driver? (Owner,
 * 14 November 2026.) A post that names one driver for certain must carry the
 * CDL's first and last name (one letter of tolerance in words of five letters
 * or more); a mismatch writes nothing. A post that names nobody may take the
 * CDL's name to create the candidate. Names are made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  postNameState, cdlNameMatches, crossCheckName, identityFromCdl,
} = require('../lib/hiringStages/cdlName');

const cdl = (first, last, extra = {}) => ({ first_name: first, last_name: last, ...extra });

test('the post\'s typed name: certain, none, or maybe more than one driver', () => {
  assert.deepEqual(postNameState('Company Driver - 99 CPM\nKWAME ASANTE\n(555) 201-3344'),
    { state: 'certain', name: 'Kwame Asante' });
  assert.deepEqual(postNameState('Company Driver - 99 CPM\n(555) 201-3344'), { state: 'none' });
  assert.deepEqual(postNameState(''), { state: 'none' });
  assert.equal(postNameState('Team drivers\nKWAME ASANTE\nLEAH GOODWIN').state, 'team');
  assert.equal(postNameState('KWAME ASANTE\nLEAH GOODWIN').state, 'team');
  assert.equal(postNameState('KWAME ASANTE\nleah goodwin').state, 'team', 'a second name in small letters');
});

test('MATCH: first and last name are the post\'s words, in any order, with one letter of tolerance', () => {
  assert.ok(cdlNameMatches(cdl('Kwame', 'Asante'), 'Kwame Asante'));
  assert.ok(cdlNameMatches(cdl('Samuel', 'Phillips', { middle_name: 'Jahbari' }), 'PHILLIPS SAMUEL JAHBARI'), 'surname first');
  assert.ok(cdlNameMatches(cdl('Leah Ann', 'Goodwin'), 'Goowin Leah Ann'), 'Goodwin / Goowin: one letter, 7 letters');
  assert.ok(cdlNameMatches(cdl('Destin', 'Johnes'), 'Destin Jones'), 'six letters, one letter off');
  assert.ok(cdlNameMatches(cdl('Maria', 'Lopez-Garcia'), 'Maria Lopez Garcia'), 'a double surname written apart');
  assert.ok(cdlNameMatches(cdl('Kwame', 'Asante', { suffix: 'Jr' }), 'Kwame Asante Jr.'));
});

test('MISMATCH: another person, a short word one letter off, or a surname missing', () => {
  assert.equal(cdlNameMatches(cdl('Kwame', 'Asante'), 'Kofi Asante'), false);
  assert.equal(cdlNameMatches(cdl('Ann', 'Lee'), 'Ann Lea'), false, 'under five letters: exact only');
  assert.equal(cdlNameMatches(cdl('Kwame', 'Asante'), 'Kwame'), false);
  assert.equal(cdlNameMatches(cdl('Kwame', 'Asante'), 'Kwame Asantewaa'), false);
  assert.equal(cdlNameMatches(cdl('Kwame', 'Asante Mensah'), 'Kwame Asante'), false, 'every word of the last name');
  assert.equal(cdlNameMatches(cdl('Asante', 'Asante'), 'Asante Kwame'), false, 'one post word cannot be two CDL words');
});

test('crossCheckName: the post\'s name first, else the contact\'s real name, else the CDL alone', () => {
  const v = cdl('Kwame', 'Asante');
  assert.equal(crossCheckName({ values: v, postName: 'Kwame Asante' }), 'match');
  assert.equal(crossCheckName({ values: v, postName: 'Leah Goodwin' }), 'differs');
  assert.equal(crossCheckName({ values: v, postName: null, contact: { first: 'Kwame', last: 'Asante', name: 'Kwame Asante' } }), 'match');
  assert.equal(crossCheckName({ values: v, postName: null, contact: { first: 'Leah', last: 'Goodwin', name: 'Leah Goodwin' } }), 'differs');
  assert.equal(crossCheckName({ values: v, postName: null, contact: { first: 'No name', last: '', name: 'No name' } }), 'cdl_only');
  assert.equal(crossCheckName({ values: v, postName: null, contact: null }), 'cdl_only');
  assert.equal(crossCheckName({ values: { last_name: 'Asante' }, postName: 'Kwame Asante' }), 'no_name');
});

test('identityFromCdl: the CDL\'s name and the ONE typed phone; anything less creates nothing', () => {
  const id = identityFromCdl({ values: cdl('Leah', 'Goodwin', { middle_name: 'Ann' }), phones: ['5552013344', '+1 (555) 201-3344'] });
  assert.deepEqual(id, {
    ok: true, name: 'Leah Ann Goodwin', displayName: 'Leah Ann Goodwin', first: 'Leah Ann', last: 'Goodwin',
    phone: '5552013344', fromCdl: true,
  });
  assert.equal(identityFromCdl({ values: cdl('Leah', 'Goodwin'), phones: [] }).reason, 'no_phone');
  assert.equal(identityFromCdl({ values: cdl('Leah', 'Goodwin'), phones: ['5552013344', '5559990000'] }).reason, 'several_phones');
  assert.equal(identityFromCdl({ values: { first_name: 'Leah' }, phones: ['5552013344'] }).reason, 'no_name');
});
