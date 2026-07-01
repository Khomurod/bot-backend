/**
 * buildDriverTag wiring: a driver row carrying the Telegram identity selected
 * in Driver Groups (telegram_user_id + telegram_username on driver_profiles,
 * joined onto alert/monitor rows) must produce a working tag even when the
 * driver has NO @username — via a tg://user?id inline mention.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDriverTag } = require('../services/fuelStopAlertService');

test('buildDriverTag prefers the stored @username', async () => {
  const tag = await buildDriverTag({
    telegram_username: 'joe_d',
    telegram_user_id: '5021',
    first_name: 'Joe',
    last_name: 'Driver',
  });
  assert.equal(tag, '@joe_d');
});

test('buildDriverTag tags a username-less selected member via inline mention', async () => {
  const tag = await buildDriverTag({
    telegram_username: null,
    telegram_user_id: '5021',
    first_name: 'Joe',
    last_name: 'Driver',
  });
  assert.equal(tag, '<a href="tg://user?id=5021">Joe Driver</a>');
});

test('buildDriverTag handles a BIGINT id returned by pg as a string beyond 2^53', async () => {
  const bigId = '9007199254740993'; // 2^53 + 1 — must not be coerced through Number
  const tag = await buildDriverTag({
    telegram_user_id: bigId,
    first_name: 'Jane',
  });
  assert.equal(tag, `<a href="tg://user?id=${bigId}">Jane</a>`);
});

test('buildDriverTag falls back to the generic label when the row has no name', async () => {
  const tag = await buildDriverTag({ telegram_user_id: '77' });
  assert.equal(tag, '<a href="tg://user?id=77">Driver</a>');
});
