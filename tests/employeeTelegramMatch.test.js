'use strict';

/**
 * Suggesting which Telegram account is which employee. Strict on purpose: no
 * suggestion beats a wrong one, and a username is never evidence.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { suggestTelegramAccounts, accountNameParts } = require('../services/employees/telegramMatch');

const acct = (id, first, last = null, username = null) => ({
  telegram_user_id: id, first_name: first, last_name: last, username,
});

test('a two-word American name matches the account that carries both words', () => {
  const out = suggestTelegramAccounts(
    [{ id: 1, first_name: 'TESTBEK', american_name: 'Sample Person' }],
    [acct(11, 'Sample', 'Person', 'sample_p'), acct(12, 'Sample', 'Other'), acct(13, 'Person')]
  );
  assert.deepEqual(out, [{ employeeId: 1, telegramUserId: '11', username: 'sample_p', level: 'strong' }]);
});

test('job words and "|" are ignored: "Tess Example | Dispatch" is Tess Example', () => {
  assert.deepEqual(accountNameParts(acct(1, 'Tess Example', '| Dispatch')), [['tess', 'example']]);
  assert.deepEqual(accountNameParts(acct(1, 'Ozod | Oscar Example')), [['ozod'], ['oscar', 'example']]);
  const out = suggestTelegramAccounts(
    [{ id: 1, first_name: 'X', american_name: 'Tess Example' }],
    [acct(21, 'Tess Example', '| Dispatch', 'tess_ex')]
  );
  assert.equal(out[0].telegramUserId, '21');
});

test('a one-word American name, or the Uzbek first name, matches the first word of a part', () => {
  const out = suggestTelegramAccounts(
    [
      { id: 1, first_name: 'ZEBO', american_name: 'Quinn' },
      { id: 2, first_name: 'OZOD', american_name: 'Oscar Example' },
    ],
    [acct(31, 'Quinn | Update'), acct(32, 'Ozod | Somebody')]
  );
  assert.deepEqual(out.map((s) => [s.employeeId, s.telegramUserId, s.level]), [[1, '31', 'weak'], [2, '32', 'weak']]);
});

test('two accounts that fit equally well suggest nothing', () => {
  const out = suggestTelegramAccounts(
    [{ id: 1, first_name: 'X', american_name: 'Quinn' }],
    [acct(41, 'Quinn'), acct(42, 'Quinn | Update')]
  );
  assert.deepEqual(out, []);
});

test('an account two employees both picked is suggested to neither', () => {
  const out = suggestTelegramAccounts(
    [{ id: 1, first_name: 'X', american_name: 'Quinn' }, { id: 2, first_name: 'QUINN', american_name: '' }],
    [acct(51, 'Quinn')]
  );
  assert.deepEqual(out, []);
});

test('NEVER ON A USERNAME: an account whose only resemblance is the username does not match', () => {
  const out = suggestTelegramAccounts(
    [{ id: 1, first_name: 'X', american_name: 'Sample Person' }],
    [acct(61, 'Someone', 'Else', 'sample_person')]
  );
  assert.deepEqual(out, []);
});

test('a strong match beats a weak one; apostrophes do not split a name', () => {
  const out = suggestTelegramAccounts(
    [{ id: 1, first_name: 'X', american_name: "Casey O'Example" }],
    [acct(71, 'Casey'), acct(72, 'Casey', 'OExample')]
  );
  assert.equal(out[0].telegramUserId, '72');
  assert.equal(out[0].level, 'strong');
});

test('the same account seen twice counts once; an invalid id is ignored', () => {
  const out = suggestTelegramAccounts(
    [{ id: 1, first_name: 'X', american_name: 'Quinn' }],
    [acct(81, 'Quinn'), acct('81', 'Quinn'), acct(null, 'Quinn'), acct('-5', 'Quinn')]
  );
  assert.deepEqual(out.map((s) => s.telegramUserId), ['81']);
});
