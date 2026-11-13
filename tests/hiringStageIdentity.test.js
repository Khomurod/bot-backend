'use strict';

/**
 * lib/hiringStages/identity.js — when a conversation's candidate is certain
 * enough to CREATE a Bitrix contact and deal for. Pure. Names and numbers are
 * made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { candidateIdentity, splitName } = require('../lib/hiringStages/identity');

const CARD = 'Company Driver - 99 CPM\n\nKWAME ASANTE\n(555) 201-3344\n9+ yrs of exp\n\nMatthew\'s referral';

test('one name off the post, one phone: certain — the referral line is not a second driver', () => {
  assert.deepEqual(candidateIdentity({ postText: CARD, phones: ['5552013344'] }), {
    ok: true, name: 'Kwame Asante', displayName: 'Kwame Asante', first: 'Kwame', last: 'Asante', phone: '5552013344',
  });
  assert.equal(candidateIdentity({ postText: CARD, phones: ['5552013344', '5552013344'], modelName: 'kwame' }).ok, true);
});

test('anything less is refused, in plain words, still carrying the one name to search by', () => {
  const refused = (postText, phones, modelName = null) => candidateIdentity({ postText, phones, modelName });
  assert.deepEqual(refused(CARD, []), {
    ok: false, reason: 'no_phone', note: 'no phone number was written for the driver', name: 'Kwame Asante',
  });
  assert.equal(refused(CARD, ['5552013344', '5559990000']).reason, 'several_phones');
  assert.equal(refused('Company team drivers\nKWAME ASANTE (main)\nYAW BOATENG', ['5552013344']).reason, 'team');
  assert.equal(refused('Team Driver For UNIT 310 AKMAL RUSTAMOV\nSardor Karimov', ['5552013344']).reason, 'team');
  assert.equal(refused('KWAME ASANTE\nyaw boateng', ['5552013344']).reason, 'unsure_name');
  assert.equal(refused('Company Driver - 99 CPM\n(555) 201-3344', ['5552013344']).reason, 'no_name');
  const mismatch = refused(CARD, ['5552013344'], 'Matthew Lee');
  assert.equal(mismatch.reason, 'name_mismatch');
  assert.equal(mismatch.name, null, 'a name the model contradicts is not searched by');
});

test('the name is split as written — the last word is the surname field, suffixes stay with it', () => {
  assert.deepEqual(splitName('Phillips Samuel Jahbari'), { first: 'Phillips Samuel', last: 'Jahbari' });
  assert.deepEqual(splitName('Sharp James Edward Iii'), { first: 'Sharp James', last: 'Edward III' });
  assert.deepEqual(splitName('Hills Emanuel Jr'), { first: 'Hills', last: 'Emanuel Jr' });
  assert.equal(splitName('Kwame'), null);
});
