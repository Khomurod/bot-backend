const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const NOW = '2026-07-13T12:00:00.000Z';

function loadService({ due = [], claimResult, settings } = {}) {
  const servicePath = path.resolve(__dirname, '../services/homeTimeReminderService.js');
  const htPath = path.resolve(__dirname, '../database/homeTime.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  const geminiPath = path.resolve(__dirname, '../services/geminiClient.js');
  for (const p of [servicePath, htPath, htmlPath, geminiPath]) delete require.cache[p];

  const claims = [];
  const marks = [];
  const sends = [];

  require.cache[htPath] = {
    exports: {
      async getHomeTimeSettings() {
        return settings || { enabled: true, reminder_first_hours: 12, reminder_second_hours: 12 };
      },
      async listDueHomeTimeReminders() { return due; },
      async claimHomeTimeReminder(id, opts) {
        claims.push({ id, ...opts });
        // Default: the claim succeeds and returns the (now-advanced) row.
        if (typeof claimResult === 'function') return claimResult(id, opts);
        const row = due.find((r) => r.id === id);
        return { ...row, reminder_count: Number(row.reminder_count) + 1 };
      },
      async markHomeTimeClarificationUnanswered(id) { marks.push(id); return { id }; },
    },
  };
  require.cache[htmlPath] = { exports: { safeSend: async (fn) => fn() } };
  require.cache[geminiPath] = {
    exports: {
      async callGeminiText() { throw new Error('no key'); }, // force deterministic fallback text
    },
  };

  const telegram = {
    async sendMessage(chatId, text, extra) { sends.push({ chatId, text, extra }); return { message_id: 1 }; },
  };
  return { service: require(servicePath), telegram, claims, marks, sends };
}

function dueRow(over = {}) {
  return {
    id: 1, reminder_count: 0, status: 'awaiting_return_to_road',
    group_telegram_id: '-100', group_active: true, root_message_id: 55,
    telegram_user_id: '900', telegram_username: 'driver', first_name: 'Pat', last_name: 'D',
    language: 'en', unit_number: '5', group_name: 'U5', ...over,
  };
}

test('first reminder is sent once, replying to the root message, and reschedules', async () => {
  const { service, telegram, claims, sends, marks } = loadService({ due: [dueRow({ reminder_count: 0 })] });
  const res = await service.runHomeTimeReminderCheck(telegram, { nowIso: NOW });
  assert.equal(res.sent, 1);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].expectedReminderCount, 0);
  assert.notEqual(claims[0].nextReminderAt, null); // second reminder scheduled
  assert.equal(sends.length, 1);
  assert.equal(sends[0].extra.reply_to_message_id, 55);
  assert.match(sends[0].text, /back on the road/i);
  assert.match(sends[0].text, /tg:\/\/user\?id=900/); // driver tagged by stable id
  assert.equal(marks.length, 0);
});

test('second reminder is the final one: clears the schedule and marks unanswered', async () => {
  const { service, telegram, claims, sends, marks } = loadService({ due: [dueRow({ reminder_count: 1 })] });
  const res = await service.runHomeTimeReminderCheck(telegram, { nowIso: NOW });
  assert.equal(res.sent, 1);
  assert.equal(claims[0].nextReminderAt, null); // no third reminder scheduled
  assert.equal(marks.length, 1); // flagged for manual follow-up
  assert.equal(res.unanswered, 1);
});

test('a lost claim (overlapping worker / restart) does NOT double-send', async () => {
  const { service, telegram, sends } = loadService({
    due: [dueRow({ reminder_count: 0 })],
    claimResult: () => null, // someone else already claimed it
  });
  const res = await service.runHomeTimeReminderCheck(telegram, { nowIso: NOW });
  assert.equal(res.sent, 0);
  assert.equal(sends.length, 0);
});

test('inactive groups are skipped (no reminder)', async () => {
  const { service, telegram, claims, sends } = loadService({ due: [dueRow({ group_active: false })] });
  const res = await service.runHomeTimeReminderCheck(telegram, { nowIso: NOW });
  assert.equal(res.sent, 0);
  assert.equal(claims.length, 0);
  assert.equal(sends.length, 0);
});

test('missing-field wording matches the awaiting status', async () => {
  const { service } = loadService({});
  assert.equal(service.missingFieldFor({ status: 'awaiting_return_to_road' }), 'return_to_road');
  assert.equal(service.missingFieldFor({ status: 'awaiting_home_start' }), 'home_start');
  assert.equal(service.missingFieldFor({ status: 'awaiting_dates' }), 'both');
});

test('disabled feature performs no work', async () => {
  const { service, telegram, sends } = loadService({ due: [dueRow()], settings: { enabled: false } });
  const res = await service.runHomeTimeReminderCheck(telegram, { nowIso: NOW });
  assert.equal(res.enabled, false);
  assert.equal(sends.length, 0);
});
