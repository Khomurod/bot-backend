const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

const claimedRuns = new Set();
const sentMessages = [];
let sendShouldFail = false;
const birthdayDb = {
  getGroupsWithBirthdayToday: async () => [{
    id: 1,
    telegram_group_id: '-100123',
    group_name: 'WENZE UNIT # 1 DRIVER',
  }],
  claimServiceRun: async (serviceName, runKey) => {
    const key = `${serviceName}:${runKey}`;
    if (claimedRuns.has(key)) return false;
    claimedRuns.add(key);
    return true;
  },
  unclaimServiceRun: async (serviceName, runKey) => claimedRuns.delete(`${serviceName}:${runKey}`),
};

require.cache[require.resolve('../database/db')] = { exports: birthdayDb };
require.cache[require.resolve('../bot/bot')] = {
  exports: {
    bot: {
      telegram: {
        sendMessage: async (...args) => {
          if (sendShouldFail) throw new Error('simulated telegram failure');
          sentMessages.push(args);
          return { message_id: 10 };
        },
      },
    },
  },
};
require.cache[require.resolve('../services/telegramHtml')] = {
  exports: { safeSend: async (fn) => fn() },
};
require.cache[require.resolve('../services/driverGroupTitle')] = {
  exports: { extractDriverNameFromGroupTitle: () => 'Driver' },
};

const {
  getDriverBirthdayScheduledTime,
  isPastDriverBirthdaySchedule,
  processDriverBirthdays,
} = require('../services/birthdayService');

test('driver birthday schedule is 8:00 America/Chicago', () => {
  const scheduled = getDriverBirthdayScheduledTime('2026-06-12');
  assert.equal(scheduled.hour, 8);
  assert.equal(scheduled.minute, 0);
  assert.equal(scheduled.zoneName, 'America/Chicago');
});

test('isPastDriverBirthdaySchedule is false before 8 AM and true at or after', () => {
  const before = DateTime.fromObject(
    { year: 2026, month: 6, day: 12, hour: 7, minute: 59 },
    { zone: 'America/Chicago' }
  );
  const at = before.plus({ minute: 1 });
  const after = before.plus({ hours: 3 });

  assert.equal(isPastDriverBirthdaySchedule(before), false);
  assert.equal(isPastDriverBirthdaySchedule(at), true);
  assert.equal(isPastDriverBirthdaySchedule(after), true);
});

test('claimed birthday run is not resent after its Telegram message is deleted', async () => {
  claimedRuns.clear();
  sentMessages.length = 0;
  sendShouldFail = false;

  await processDriverBirthdays('2026-06-14', 6, 14);
  assert.equal(sentMessages.length, 1);
  // Idempotency key is now per-group: driver:<groupId>:<isoDate>.
  assert.equal(claimedRuns.has('birthday:driver:1:2026-06-14'), true);

  // Deleting the Telegram message does not remove or alter the service run.
  await processDriverBirthdays('2026-06-14', 6, 14);
  assert.equal(sentMessages.length, 1);
});

test('a failed driver send releases its per-group claim so the next tick retries', async () => {
  claimedRuns.clear();
  sentMessages.length = 0;

  // First tick: send fails -> claim must be released, nothing sent.
  sendShouldFail = true;
  await processDriverBirthdays('2026-06-15', 6, 15);
  assert.equal(sentMessages.length, 0);
  assert.equal(claimedRuns.has('birthday:driver:1:2026-06-15'), false);

  // Next tick same day: send succeeds -> claimed and sent exactly once.
  sendShouldFail = false;
  await processDriverBirthdays('2026-06-15', 6, 15);
  assert.equal(sentMessages.length, 1);
  assert.equal(claimedRuns.has('birthday:driver:1:2026-06-15'), true);
});
