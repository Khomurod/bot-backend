const test = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');

let employeesToday = [{ id: 1, first_name: 'ALPHA', last_name: 'BRAVO', birthday: '1990-01-01', american_name: 'Test Person', telegram_username: 'test_person' }];

const settings = {
  timezone: 'Asia/Tashkent',
  send_hour: 0,
  send_minute: 0,
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
  // A claim is "stale" in these tests when its key is in staleKeys.
  releaseStaleServiceRun: async (service, runKey, minutes) => {
    assert.equal(minutes, 10);
    const key = `${service}:${runKey}`;
    if (!staleKeys.has(key)) return false;
    staleKeys.delete(key);
    return claimedKeys.delete(key);
  },
};
const staleKeys = new Set();

// What reached Telegram: one entry per posted card.
const sentMessages = [];
let sendShouldFail = false;
let failForEmployeeId = null;
let hangSend = false;
const photos = new Map();
const rendered = [];

require.cache[require.resolve('../database/db')] = { exports: db };
require.cache[require.resolve('../database/companyEmployees')] = {
  exports: { getPhoto: async (id) => photos.get(id) || null },
};
require.cache[require.resolve('../config/config')] = {
  exports: { employeeGroupId: '-100123' },
};
require.cache[require.resolve('../bot/bot')] = {
  exports: {
    bot: {
      telegram: {
        callApi: async (method, payload, { signal } = {}) => {
          assert.equal(method, 'sendPhoto');
          assert.ok(signal instanceof AbortSignal, 'every card send carries a deadline');
          const file = payload.photo;
          if (sendShouldFail || String(file.source) === `card:${failForEmployeeId}`) {
            throw new Error('simulated telegram failure');
          }
          if (hangSend) {
            await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
          }
          sentMessages.push({ chatId: payload.chat_id, file, caption: payload.caption, parseMode: payload.parse_mode });
        },
      },
    },
  },
};
require.cache[require.resolve('../services/telegramHtml')] = {
  exports: { safeSend: async (fn) => fn() },
};
require.cache[require.resolve('../services/employees/birthdayCard')] = {
  exports: {
    renderBirthdayCard: async (employee, photo) => {
      if (photo === 'broken') throw new Error('unsupported image format');
      rendered.push({ id: employee.id, photo });
      return `card:${employee.id}`;
    },
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
  // The employee's card first, then the day — written only once every card is out.
  assert.deepEqual(claims.map((c) => c[1]), [`employee:${now.toISODate()}:1`, `employee:${now.toISODate()}:1:sent`]);

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
  await assert.rejects(() => runEmployeeBirthdayWishes({ claimDailyRun: true }), /ALPHA BRAVO/);
  assert.equal(claimedKeys.has(`birthday:employee:${isoDate}`), false);
  assert.equal(claimedKeys.has(`birthday:employee:${isoDate}:1`), false);
  assert.equal(sentMessages.length, 0);

  // Retry the same day: delivery succeeds, claim is taken, message sent once.
  sendShouldFail = false;
  const retry = await runEmployeeBirthdayWishes({ claimDailyRun: true });
  assert.equal(retry.sent, true);
  assert.equal(sentMessages.length, 1);
  assert.equal(claimedKeys.has(`birthday:employee:${isoDate}:1:sent`), true);
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

test('a day the previous version already wished (its day key) is not wished again', async () => {
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
  assert.equal(result.reason, 'already_sent');
  assert.equal(sentMessages.length, 0);

  db.getEmployeeBirthdaySettings = origSettings;
});

function resetState() {
  claims.length = 0;
  claimedKeys.clear();
  sentMessages.length = 0;
  rendered.length = 0;
  photos.clear();
  staleKeys.clear();
  sendShouldFail = false;
  failForEmployeeId = null;
}

test('the card goes out as a photo with the owner\'s fixed caption and the tag', async () => {
  resetState();
  photos.set(1, Buffer.from('jpeg'));
  const result = await runEmployeeBirthdayWishes({ claimDailyRun: true });
  assert.equal(result.sent, true);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].chatId, '-100123');
  assert.equal(sentMessages[0].file.source, 'card:1');
  assert.equal(sentMessages[0].parseMode, 'HTML');
  assert.equal(
    sentMessages[0].caption,
    'Dear @test_person,\n\nWishing you all the best that life has to offer.\nTogether, we grow stronger and achieve more!'
  );
  assert.deepEqual(rendered, [{ id: 1, photo: photos.get(1) }]);
});

test('one card per employee; a failed one is retried without re-posting the others', async () => {
  resetState();
  const saved = employeesToday;
  employeesToday = [
    { id: 1, first_name: 'ALPHA', last_name: 'BRAVO', birthday: '1990-01-01' },
    { id: 2, first_name: 'CHARLIE', last_name: 'DELTA', birthday: '1991-01-01' },
  ];
  try {
    failForEmployeeId = 2;
    await assert.rejects(() => runEmployeeBirthdayWishes({ claimDailyRun: true }), /CHARLIE DELTA/);
    assert.deepEqual(sentMessages.map((m) => m.file.source), ['card:1']);

    failForEmployeeId = null;
    const retry = await runEmployeeBirthdayWishes({ claimDailyRun: true });
    assert.equal(retry.sent, true);
    assert.equal(retry.names, 'CHARLIE DELTA');
    assert.deepEqual(sentMessages.map((m) => m.file.source), ['card:1', 'card:2']);

    const again = await runEmployeeBirthdayWishes({ claimDailyRun: true });
    assert.equal(again.reason, 'already_sent');
    assert.equal(sentMessages.length, 2);
  } finally {
    employeesToday = saved;
  }
});

test('a stored photo that no longer decodes posts the card with initials instead', async () => {
  resetState();
  photos.set(1, 'broken');
  const result = await runEmployeeBirthdayWishes({ claimDailyRun: true });
  assert.equal(result.sent, true);
  assert.deepEqual(rendered, [{ id: 1, photo: null }]);
  assert.equal(sentMessages.length, 1);
});

test('a card another pass is still posting is left to it; a claim left by a stopped process is taken over', async () => {
  resetState();
  const isoDate = DateTime.now().setZone('Asia/Tashkent').toISODate();
  claimedKeys.add(`birthday:employee:${isoDate}:1`); // a fresh claim: another pass is posting
  const busy = await runEmployeeBirthdayWishes({ claimDailyRun: true });
  assert.equal(busy.reason, 'already_sent');
  assert.equal(sentMessages.length, 0);

  staleKeys.add(`birthday:employee:${isoDate}:1`); // the same claim, now older than ten minutes
  const recovered = await runEmployeeBirthdayWishes({ claimDailyRun: true });
  assert.equal(recovered.sent, true);
  assert.equal(sentMessages.length, 1);
  assert.equal(claimedKeys.has(`birthday:employee:${isoDate}:1:sent`), true);
});

test('someone added with today\'s birthday after the cards went out still gets theirs', async () => {
  resetState();
  const saved = employeesToday;
  try {
    assert.equal((await runEmployeeBirthdayWishes({ claimDailyRun: true })).sent, true);
    employeesToday = [...saved, { id: 7, first_name: 'LATE', last_name: 'ADDITION', birthday: '1995-01-01' }];
    const later = await runEmployeeBirthdayWishes({ claimDailyRun: true });
    assert.equal(later.names, 'LATE ADDITION');
    assert.deepEqual(sentMessages.map((m) => m.file.source), ['card:1', 'card:7']);
  } finally {
    employeesToday = saved;
  }
});

test('a send that hangs is abandoned at the deadline, so a takeover can never race it', async (t) => {
  resetState();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  hangSend = true;
  try {
    const run = runEmployeeBirthdayWishes({ claimDailyRun: true });
    // Let the pass reach the send, then pass the three-minute deadline.
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(3 * 60 * 1000);
    await assert.rejects(run, /Could not post the birthday card/);
    const isoDate = DateTime.now().setZone('Asia/Tashkent').toISODate();
    assert.equal(claimedKeys.has(`birthday:employee:${isoDate}:1`), false, 'released for the retry');
    assert.equal(sentMessages.length, 0);
  } finally {
    hangSend = false;
  }
});
