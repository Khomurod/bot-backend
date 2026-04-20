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
  assert.equal(sendCalls.length, 1, 'broadcast should be sent once for same message id');
  assert.equal(claimAttempts.length, 2, 'both concurrent ticks attempt to claim lock');
  assert.equal(claimState.has(7), true, 'first tick should claim message 7');
  assert.equal(statusUpdates.length, 1, 'message should be finalized exactly once');
  assert.deepEqual(statusUpdates[0], [7, 'sent']);
});
