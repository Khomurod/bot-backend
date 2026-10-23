'use strict';

/**
 * The words on an employee birthday post: the owner's fixed caption, the tag,
 * and the names the card prints. Made-up names throughout.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../services/employees/birthdayText');

const FIXED = '\n\nWishing you all the best that life has to offer.\nTogether, we grow stronger and achieve more!';

test('the caption is the owner\'s text word for word, tagging the @username', () => {
  const caption = T.birthdayCaption({ first_name: 'TESTBEK', american_name: 'Sample Person', telegram_username: 'sample_person' });
  assert.equal(caption, `Dear @sample_person,${FIXED}`);
});

test('no username: an inline mention by id, named by the American name', () => {
  const caption = T.birthdayCaption({ first_name: 'TESTBEK', american_name: 'Sample <Person>', telegram_user_id: '123456789' });
  assert.equal(caption, `Dear <a href="tg://user?id=123456789">Sample &lt;Person&gt;</a>,${FIXED}`);
});

test('no Telegram account at all: the name as plain text, never broken markup', () => {
  assert.equal(T.birthdayCaption({ first_name: 'TESTBEK', american_name: '' }), `Dear Testbek,${FIXED}`);
  assert.equal(T.birthdayCaption({ first_name: 'TESTBEK', american_name: 'Sam & Co' }), `Dear Sam &amp; Co,${FIXED}`);
});

test('the card prints the FULL first name, not in capitals', () => {
  assert.equal(T.cardFirstName({ first_name: 'TESTBEK' }), 'Testbek');
  assert.equal(T.cardFirstName({ first_name: "O'RTOQBOY" }), "O'rtoqboy");
  assert.equal(T.cardFirstName({ first_name: 'GʻAYRAT' }), 'Gʻayrat');
  assert.equal(T.cardFirstName({ first_name: '  muhammad   ali ' }), 'Muhammad Ali');
  assert.equal(T.cardFirstName({ first_name: 'ANNA-MARIA' }), 'Anna-Maria');
});

test('the American name is printed as typed; initials stand in for a missing photo', () => {
  assert.equal(T.cardAmericanName({ american_name: '  Sample   Person ' }), 'Sample Person');
  assert.equal(T.cardAmericanName({}), '');
  assert.equal(T.initials({ first_name: 'TESTBEK', last_name: 'EXAMPLOV' }), 'TE');
  assert.equal(T.initials({ first_name: 'TESTBEK', last_name: '' }), 'T');
  assert.equal(T.initials({}), '?');
});
