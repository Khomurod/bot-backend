const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadSchedulerWithMocks(dbMock, botMock) {
  const schedulerPath = path.resolve(__dirname, '../services/schedulerService.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const botPath = path.resolve(__dirname, '../bot/bot.js');

  delete require.cache[schedulerPath];
  delete require.cache[dbPath];
  delete require.cache[botPath];

  require.cache[dbPath] = { exports: dbMock };
  require.cache[botPath] = { exports: botMock };

  return require(schedulerPath);
}

test('tick lock prevents duplicate sends on concurrent runs', async () => {
  const sendCalls = [];
  const claimState = new Set();
  const claimAttempts = [];
  const statusUpdates = [];

  const dbMock = {
    async getPendingScheduledMessages() {
      return [
        {
          id: 7,
          target_type: 'all',
          message_text_en: 'hello',
          media_position: 'above',
        },
      ];
    },
    async claimScheduledMessage(id) {
      claimAttempts.push(id);
      if (claimState.has(id)) return null;
      claimState.add(id);
      return {
        id,
        target_type: 'all',
        message_text_en: 'hello',
        message_text_ru: null,
        message_text_uz: null,
        media_file_id: null,
        media_type: null,
        media_position: 'above',
        force_language: null,
      };
    },
    async getAllDriverGroups() {
      return [{ id: 1, language: 'en', telegram_group_id: -1001, group_name: 'Group' }];
    },
    async updateScheduledMessageStatus() {
      statusUpdates.push([...arguments]);
      return {};
    },
  };

  const botMock = {
    async sendBroadcastToGroups(groups) {
      sendCalls.push(groups);
      return { sent: 1, failed: 0 };
    },
  };

  const scheduler = loadSchedulerWithMocks(dbMock, botMock);

  await Promise.all([scheduler.tick(), scheduler.tick()]);
  // The scheduler now has a per-process tickRunning guard: the second
  // concurrent tick early-returns BEFORE issuing any DB work. DB-level
  // idempotency (the partial index on pending scheduled_messages and the
  // claim row-lock) still protects multi-instance deploys. What this test
  // asserts is the invariant both guards must satisfy together:
  //   → exactly one broadcast send
  //   → exactly one status finalization
  assert.equal(sendCalls.length, 1, 'broadcast should be sent once for same message id');
  assert.ok(claimAttempts.length >= 1, 'at least one tick must attempt to claim the message');
  assert.equal(claimState.has(7), true, 'winning tick should claim message 7');
  assert.equal(statusUpdates.length, 1, 'message should be finalized exactly once');
  assert.deepEqual(statusUpdates[0], [7, 'sent']);
});

test('tick guard lets a second tick run after the first completes', async () => {
  let callIndex = 0;
  const dbMock = {
    async getPendingScheduledMessages() {
      callIndex += 1;
      if (callIndex === 1) {
        return [{ id: 9, target_type: 'all', message_text_en: 'first', media_position: 'above' }];
      }
      return [{ id: 10, target_type: 'all', message_text_en: 'second', media_position: 'above' }];
    },
    async claimScheduledMessage(id) {
      return {
        id, target_type: 'all', message_text_en: `msg-${id}`,
        message_text_ru: null, message_text_uz: null,
        media_file_id: null, media_type: null, media_position: 'above',
        force_language: null,
      };
    },
    async getAllDriverGroups() {
      return [{ id: 1, language: 'en', telegram_group_id: -1001, group_name: 'G' }];
    },
    async updateScheduledMessageStatus() {},
  };
  const sent = [];
  const botMock = {
    async sendBroadcastToGroups() {
      sent.push(true);
      return { sent: 1, failed: 0 };
    },
  };

  const scheduler = loadSchedulerWithMocks(dbMock, botMock);
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(sent.length, 2, 'tickRunning must reset between sequential ticks');
});

test('weekly scheduled message reschedules itself after a successful send', async () => {
  const recurringRuns = [];
  const dbMock = {
    async getAllDriverGroups() {
      return [{ id: 1, language: 'en', telegram_group_id: -1001, group_name: 'Group' }];
    },
    async recordRecurringScheduledMessageRun(id, nextScheduledAt, lastRunStatus, markSent) {
      recurringRuns.push({ id, nextScheduledAt, lastRunStatus, markSent });
      return {};
    },
    async updateScheduledMessageStatus() {
      throw new Error('one-time status updater should not be used for weekly schedules');
    },
  };
  const botMock = {
    async sendBroadcastToGroups() {
      return { sent: 1, failed: 0 };
    },
  };

  const scheduler = loadSchedulerWithMocks(dbMock, botMock);
  const result = await scheduler.processMessage({
    id: 11,
    schedule_type: 'weekly',
    schedule_timezone: 'America/Chicago',
    weekly_day_of_week: 1,
    weekly_time_local: '09:00',
    target_type: 'all',
    message_text_en: 'hello',
    message_text_ru: null,
    message_text_uz: null,
    media_items: [{ file_id: 'photo-1', type: 'photo' }],
    media_position: 'above',
    force_language: null,
  });

  assert.equal(result.status, 'sent');
  assert.equal(recurringRuns.length, 1, 'weekly send should schedule the next run');
  assert.equal(recurringRuns[0].id, 11);
  assert.equal(recurringRuns[0].lastRunStatus, 'sent');
  assert.equal(recurringRuns[0].markSent, true);
  assert.ok(typeof recurringRuns[0].nextScheduledAt === 'string' && recurringRuns[0].nextScheduledAt.length > 0);
});

// NOTE: The Monday "executive summary" weekly reporter has been removed.
// Its dedicated tests were deleted alongside services/weeklyReportService.js.
// Weekly *scheduled broadcasts* remain covered by the recurring-message test
// above ("weekly scheduled message reschedules itself after a successful send").
