const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

require.cache[require.resolve('../database/db')] = { exports: {} };
require.cache[require.resolve('../bot/bot')] = { exports: { bot: {} } };
require.cache[require.resolve('../services/telegramHtml')] = {
  exports: { safeSend: async (fn) => fn() },
};
require.cache[require.resolve('../services/driverGroupTitle')] = {
  exports: { extractDriverNameFromGroupTitle: () => 'Driver' },
};

const {
  getDriverBirthdayScheduledTime,
  isPastDriverBirthdaySchedule,
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
