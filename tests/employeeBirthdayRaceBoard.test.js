'use strict';

/**
 * An employee's birthday card on the race boards (services/grossRace/
 * birthdays.js): the card that was POSTED, noted only after `:sent` is
 * written, never for a card re-sent by hand, and a failure on the board's side
 * never costs the post.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const marks = new Set();
const posted = [];
let sendFails = false;
const db = {
  getEmployeeBirthdaySettings: async () => ({ timezone: 'Asia/Tashkent', send_hour: 0, send_minute: 0 }),
  getEmployeesWithBirthdayOn: async () => [{ id: 7, first_name: 'TESTBEK', last_name: 'X', american_name: 'Tom' }],
  getEmployeeBirthdaysByIds: async () => [{ id: 7, first_name: 'TESTBEK', last_name: 'X', american_name: 'Tom' }],
  hasServiceRun: async (s, k) => marks.has(`${s}:${k}`),
  claimServiceRun: async (s, k) => !marks.has(`${s}:${k}`) && Boolean(marks.add(`${s}:${k}`)),
  unclaimServiceRun: async (s, k) => marks.delete(`${s}:${k}`),
  releaseStaleServiceRun: async () => false,
};
const CARD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 7]);

require.cache[require.resolve('../database/db')] = { exports: db };
require.cache[require.resolve('../database/companyEmployees')] = { exports: { getPhoto: async () => null } };
require.cache[require.resolve('../config/config')] = { exports: { employeeGroupId: '-100123' } };
require.cache[require.resolve('../services/telegramHtml')] = { exports: { safeSend: async (fn) => fn() } };
require.cache[require.resolve('../services/employees/birthdayCard')] = { exports: { renderBirthdayCard: async () => CARD } };
require.cache[require.resolve('../bot/bot')] = {
  exports: {
    bot: {
      telegram: {
        callApi: async (_method, payload) => {
          if (sendFails) throw new Error('simulated telegram failure');
          posted.push(payload.photo.source);
        },
      },
    },
  },
};

const raceBirthdays = require('../services/grossRace/birthdays');
const { runEmployeeBirthdayWishes } = require('../services/employeeBirthdayWishService');

function reset() {
  marks.clear();
  posted.length = 0;
  sendFails = false;
  raceBirthdays.board.clear();
}

test('the day\'s card, once posted, is on the race boards: the same JPEG, the first name and the American name', async () => {
  reset();
  await runEmployeeBirthdayWishes({ claimDailyRun: true });
  assert.equal(posted.length, 1);
  const [only] = raceBirthdays.board.todaysBirthdays();
  assert.deepEqual([only.kind, only.name, only.subtitle], ['employee', 'Testbek', 'Tom']);
  assert.equal(raceBirthdays.board.cardFor(only.key), posted[0], 'the card that went to Telegram, not a new drawing');
});

test('a card that failed to post is not on the boards', async () => {
  reset();
  sendFails = true;
  const error = console.error;
  console.error = () => {};
  try {
    await assert.rejects(runEmployeeBirthdayWishes({ claimDailyRun: true }));
  } finally {
    console.error = error;
  }
  assert.deepEqual(raceBirthdays.board.todaysBirthdays(), []);
});

test('a card re-sent by hand for chosen people is not a birthday on the boards', async () => {
  reset();
  await runEmployeeBirthdayWishes({ employeeIds: [7], claimDailyRun: false });
  assert.equal(posted.length, 1);
  assert.deepEqual(raceBirthdays.board.todaysBirthdays(), []);
});

test('the boards failing costs the post nothing', async (t) => {
  reset();
  t.mock.method(raceBirthdays.board, 'noteBirthday', () => { throw new Error('board broke'); });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const result = await runEmployeeBirthdayWishes({ claimDailyRun: true });
    assert.equal(result.sent, true);
  } finally {
    console.warn = warn;
  }
  assert.equal(posted.length, 1);
  assert.ok([...marks].some((k) => k.endsWith(':7:sent')), 'marked sent');
});
