const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const employeesToday = [{ id: 1, first_name: 'A', last_name: 'B', birthday: '1990-01-01' }];

const settings = {
  timezone: 'Asia/Tashkent',
  send_hour: 0,
  send_minute: 0,
  ai_instructions: 'Test instructions',
  fallback_template: 'Hi <b>{names}</b>',
};

const claims = [];
const claimedKeys = new Set();

const db = {
  getEmployeeBirthdaySettings: async () => settings,
  getEmployeesWithBirthdayOn: async (month, day) => {
    const now = DateTime.now().setZone('Asia/Tashkent');
    if (month === now.month && day === now.day) return employeesToday;
    return [];
  },
  getEmployeeBirthdaysByIds: async (ids) => employeesToday.filter((e) => ids.includes(e.id)),
  claimServiceRun: async (service, runKey) => {
    claims.push([service, runKey]);
    const key = `${service}:${runKey}`;
    if (claimedKeys.has(key)) return false;
    claimedKeys.add(key);
    return true;
  },
  hasServiceRun: async (service, runKey) => claimedKeys.has(`${service}:${runKey}`),
  unclaimServiceRun: async (service, runKey) => claimedKeys.delete(`${service}:${runKey}`),
};

const sentMessages = [];

require.cache[require.resolve('../database/db')] = { exports: db };
require.cache[require.resolve('../config/config')] = {
  exports: { employeeGroupId: '-100123' },
};
require.cache[require.resolve('../bot/bot')] = {
  exports: {
    bot: {
      telegram: {
        sendMessage: async (chatId, text) => {
          sentMessages.push({ chatId, text });
        },
      },
    },
  },
};
let sendShouldFail = false;
require.cache[require.resolve('../services/telegramHtml')] = {
  exports: {
    safeSend: async (fn) => fn(),
    sanitizeCompanyReportHtmlForTelegram: (text) => text,
    sendTelegramHtmlChunks: async (telegram, chatId, text) => {
      if (sendShouldFail) throw new Error('simulated telegram failure');
      await telegram.sendMessage(chatId, text);
      return [{ message_id: 1 }];
    },
  },
};
require.cache[require.resolve('../services/employeeBirthdayMessage')] = {
  exports: {
    generateEmployeeBirthdayMessage: async () => ({
      message: '<b>Happy Birthday!</b>',
      provider: 'test',
      model: null,
    }),
  },
};

const {
  runEmployeeBirthdayWishes,
  checkAndRunScheduled,
  shouldRunEmployeeBirthdayAt,
  isPastEmployeeBirthdaySchedule,
} = require('../services/employeeBirthdayWishService');

test('runEmployeeBirthdayWishes with no birthdays does not claim run key', async () => {
  claims.length = 0;
  claimedKeys.clear();
  sentMessages.length = 0;

  const orig = db.getEmployeesWithBirthdayOn;
  db.getEmployeesWithBirthdayOn = async () => [];

  const result = await runEmployeeBirthdayWishes({ claimDailyRun: true });
  assert.equal(result.reason, 'no_birthdays');
  assert.equal(claims.length, 0);
  assert.equal(sentMessages.length, 0);

  db.getEmployeesWithBirthdayOn = orig;
});

test('send now claims daily key and blocks duplicate', async () => {
  claims.length = 0;
  claimedKeys.clear();
  sentMessages.length = 0;

  const now = DateTime.now().setZone('Asia/Tashkent');

  const first = await runEmployeeBirthdayWishes({ claimDailyRun: true });
  assert.equal(first.sent, true);
  assert.equal(claims.length, 1);
  assert.equal(claims[0][1], `employee:${now.toISODate()}`);

  const second = await runEmployeeBirthdayWishes({ claimDailyRun: true });
  assert.equal(second.reason, 'already_sent');
});

test('congratulate selected does not claim daily run key', async () => {
  claims.length = 0;
  claimedKeys.clear();
  sentMessages.length = 0;

  const result = await runEmployeeBirthdayWishes({ employeeIds: [1], claimDailyRun: false });
  assert.equal(result.sent, true);
  assert.equal(claims.length, 0);
});

test('shouldRunEmployeeBirthdayAt matches configured hour and minute', () => {
  const cfg = { send_hour: 12, send_minute: 30, timezone: 'Asia/Tashkent' };
  const match = DateTime.fromObject(
    { year: 2026, month: 5, day: 25, hour: 12, minute: 30 },
    { zone: 'Asia/Tashkent' }
  );
  const noMatch = match.plus({ minute: 1 });
  assert.equal(shouldRunEmployeeBirthdayAt(cfg, match), true);
  assert.equal(shouldRunEmployeeBirthdayAt(cfg, noMatch), false);
});

test('isPastEmployeeBirthdaySchedule is false before send time and true after', () => {
  const cfg = { send_hour: 12, send_minute: 30, timezone: 'Asia/Tashkent' };
  const before = DateTime.fromObject(
    { year: 2026, month: 5, day: 25, hour: 12, minute: 29 },
    { zone: 'Asia/Tashkent' }
  );
  const at = before.plus({ minute: 1 });
  const after = before.plus({ hours: 2 });
  assert.equal(isPastEmployeeBirthdaySchedule(before, cfg), false);
  assert.equal(isPastEmployeeBirthdaySchedule(at, cfg), true);
  assert.equal(isPastEmployeeBirthdaySchedule(after, cfg), true);
});

test('checkAndRunScheduled catches up after scheduled time when not yet claimed', async () => {
  claims.length = 0;
  claimedKeys.clear();
  sentMessages.length = 0;

  const now = DateTime.now().setZone('Asia/Tashkent');
  const pastHour = Math.max(0, now.hour - 1);

  const origSettings = db.getEmployeeBirthdaySettings;
  db.getEmployeeBirthdaySettings = async () => ({
    ...settings,
    send_hour: pastHour,
    send_minute: 0,
  });

  const result = await checkAndRunScheduled();
  assert.equal(result?.sent, true);
  assert.equal(sentMessages.length, 1);

  db.getEmployeeBirthdaySettings = origSettings;
});

test('failed send releases the claim so the next tick retries (no silent drop)', async () => {
  claims.length = 0;
  claimedKeys.clear();
  sentMessages.length = 0;
  const isoDate = DateTime.now().setZone('Asia/Tashkent').toISODate();

  // First attempt: delivery fails -> must throw AND leave the run UNCLAIMED.
  sendShouldFail = true;
  await assert.rejects(() => runEmployeeBirthdayWishes({ claimDailyRun: true }));
  assert.equal(claimedKeys.has(`birthday:employee:${isoDate}`), false);
  assert.equal(sentMessages.length, 0);

  // Retry the same day: delivery succeeds, claim is taken, message sent once.
  sendShouldFail = false;
  const retry = await runEmployeeBirthdayWishes({ claimDailyRun: true });
  assert.equal(retry.sent, true);
  assert.equal(sentMessages.length, 1);
  assert.equal(claimedKeys.has(`birthday:employee:${isoDate}`), true);
});

test('a successful send is not resent on a later tick', async () => {
  claims.length = 0;
  claimedKeys.clear();
  sentMessages.length = 0;
  sendShouldFail = false;

  const first = await runEmployeeBirthdayWishes({ claimDailyRun: true });
  assert.equal(first.sent, true);
  assert.equal(sentMessages.length, 1);

  const second = await runEmployeeBirthdayWishes({ claimDailyRun: true });
  assert.equal(second.reason, 'already_sent');
  assert.equal(sentMessages.length, 1);
});

test('checkAndRunScheduled skips when daily run already claimed', async () => {
  claims.length = 0;
  claimedKeys.clear();
  sentMessages.length = 0;

  const isoDate = DateTime.now().setZone('Asia/Tashkent').toISODate();
  claimedKeys.add(`birthday:employee:${isoDate}`);

  const now = DateTime.now().setZone('Asia/Tashkent');
  const pastHour = Math.max(0, now.hour - 1);

  const origSettings = db.getEmployeeBirthdaySettings;
  db.getEmployeeBirthdaySettings = async () => ({
    ...settings,
    send_hour: pastHour,
    send_minute: 0,
  });

  const result = await checkAndRunScheduled();
  assert.equal(result, null);
  assert.equal(sentMessages.length, 0);

  db.getEmployeeBirthdaySettings = origSettings;
});
