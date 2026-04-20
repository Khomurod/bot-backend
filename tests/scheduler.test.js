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

function loadWeeklyWithMocks(dbMock, botMock, configMock, aiMock) {
  const weeklyPath = path.resolve(__dirname, '../services/weeklyReportService.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const botPath = path.resolve(__dirname, '../bot/bot.js');
  const configPath = path.resolve(__dirname, '../config/config.js');
  const aiPath = path.resolve(__dirname, '../services/aiAnalysisService.js');
  const urlPath = path.resolve(__dirname, '../services/telegramUrl.js');

  delete require.cache[weeklyPath];
  delete require.cache[dbPath];
  delete require.cache[botPath];
  delete require.cache[configPath];
  delete require.cache[aiPath];
  delete require.cache[urlPath];

  require.cache[dbPath] = { exports: dbMock };
  require.cache[botPath] = { exports: botMock };
  require.cache[configPath] = { exports: configMock };
  require.cache[aiPath] = { exports: aiMock };
  require.cache[urlPath] = { exports: { buildTelegramMessageUrl: () => 'https://t.me/c/123/1' } };

  return require(weeklyPath);
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

test('weekly reporter fires once at Monday 7:00 AM Chicago', async () => {
  const sends = [];
  const inserts = [];
  const dbMock = {
    async getChatLogsForActiveDriverGroups() {
      return [{ message_text: 'x', sender_name: 'A', group_name: 'G', telegram_group_id: -100123, telegram_message_id: 1 }];
    },
    async query(sql, params) {
      inserts.push({ sql, params });
      return { rows: [] };
    },
  };
  const botMock = { bot: { telegram: { async sendMessage(chatId, text) { sends.push({ chatId, text }); } } } };
  const weekly = loadWeeklyWithMocks(
    dbMock,
    botMock,
    { managementGroupId: '-100999' },
    { generateCompanyReport: async () => '<b>Weekly</b>', AI_REPORT_GENERATION_FAILED: 'AI_REPORT_GENERATION_FAILED' }
  );

  const monday700 = { weekday: 1, hour: 7, minute: 0, toISODate: () => '2026-05-04', setZone() { return this; } };
  await weekly.checkAndRun(monday700);
  await weekly.checkAndRun(monday700);

  assert.equal(sends.length, 1, 'weekly report should send once for same day');
  assert.equal(inserts.length, 1, 'weekly report should persist once for same day');
});

test('weekly reporter does not fire Tuesday 7:00 AM Chicago', async () => {
  const sends = [];
  const dbMock = {
    async getChatLogsForActiveDriverGroups() { return []; },
    async query() { return { rows: [] }; },
  };
  const botMock = { bot: { telegram: { async sendMessage() { sends.push(true); } } } };
  const weekly = loadWeeklyWithMocks(
    dbMock,
    botMock,
    { managementGroupId: '-100999' },
    { generateCompanyReport: async () => '<b>Weekly</b>', AI_REPORT_GENERATION_FAILED: 'AI_REPORT_GENERATION_FAILED' }
  );

  const tuesday700 = { weekday: 2, hour: 7, minute: 0, toISODate: () => '2026-05-05', setZone() { return this; } };
  await weekly.checkAndRun(tuesday700);
  assert.equal(sends.length, 0, 'weekly report must not send on Tuesday');
});
