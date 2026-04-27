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

function loadWeeklyWithMocks(dbMock, botMock, configMock, aiMock, insightsMock, rendererMock, htmlMock) {
  const weeklyPath = path.resolve(__dirname, '../services/weeklyReportService.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const botPath = path.resolve(__dirname, '../bot/bot.js');
  const configPath = path.resolve(__dirname, '../config/config.js');
  const aiPath = path.resolve(__dirname, '../services/aiAnalysisService.js');
  const insightsPath = path.resolve(__dirname, '../services/aiInsightsService.js');
  const rendererPath = path.resolve(__dirname, '../services/insightRenderer.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  const urlPath = path.resolve(__dirname, '../services/telegramUrl.js');

  delete require.cache[weeklyPath];
  delete require.cache[dbPath];
  delete require.cache[botPath];
  delete require.cache[configPath];
  delete require.cache[aiPath];
  delete require.cache[insightsPath];
  delete require.cache[rendererPath];
  delete require.cache[htmlPath];
  delete require.cache[urlPath];

  require.cache[dbPath] = { exports: dbMock };
  require.cache[botPath] = { exports: botMock };
  require.cache[configPath] = { exports: configMock };
  require.cache[aiPath] = { exports: aiMock };
  require.cache[insightsPath] = {
    exports: insightsMock || {
      generateInsightReport: async () => ({
        report: { id: 1, generated_at: new Date().toISOString(), report_text: '{}' },
        cards: [{ id: 10, kind: 'pulse', title: 'Pulse', narrative_html: 'x', status: 'pending', severity: 1 }],
        pulse: { days_back: 7, total_messages: 1, active_drivers: 1, sentiment_avg: 0, positive_messages: 0, negative_messages: 0 },
      }),
    },
  };
  require.cache[rendererPath] = {
    exports: rendererMock || { renderInsightReportForTelegram: () => '<b>report</b>' },
  };
  require.cache[htmlPath] = {
    exports: htmlMock || {
      sanitizeCompanyReportHtmlForTelegram: (h) => h,
      sendTelegramHtmlChunks: async (telegram, chatId, text) => {
        await telegram.sendMessage(chatId, text);
      },
    },
  };
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

test('weekly reporter fires once at Monday 7:00 AM Chicago', async () => {
  const sends = [];
  const inserts = [];
  const claimed = new Set();
  const dbMock = {
    async claimServiceRun(service, runKey) {
      const key = `${service}:${runKey}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
    async getChatLogsForActiveDriverGroups() {
      return [{ message_text: 'x', sender_name: 'A', group_name: 'G', telegram_group_id: -100123, telegram_message_id: 1 }];
    },
    async query(sql, params) {
      inserts.push({ sql, params });
      return { rows: [] };
    },
    async saveAiReport() {
      return { id: 1, report_text: '<b>Weekly</b>' };
    },
    async getInsightsForReport() {
      return [{ id: 10, kind: 'pulse', title: 'Pulse', narrative_html: 'x', status: 'pending', severity: 1 }];
    },
    async updateAiReportStatus() {},
    async updateInsightStatus() {},
  };
  const botMock = { bot: { telegram: { async sendMessage(chatId, text) { sends.push({ chatId, text }); } } } };
  let generateCalls = 0;
  const insightsMock = {
    generateInsightReport: async () => {
      generateCalls += 1;
      return {
        report: { id: 1, generated_at: new Date().toISOString(), report_text: '{}' },
        cards: [{ id: 10, kind: 'pulse', title: 'Pulse', narrative_html: 'x', status: 'pending', severity: 1 }],
        pulse: { days_back: 7, total_messages: 1, active_drivers: 1, sentiment_avg: 0, positive_messages: 0, negative_messages: 0 },
      };
    },
  };
  const weekly = loadWeeklyWithMocks(
    dbMock,
    botMock,
    { managementGroupId: '-100999' },
    { generateCompanyReport: async () => '<b>Weekly</b>', AI_REPORT_GENERATION_FAILED: 'AI_REPORT_GENERATION_FAILED' },
    insightsMock
  );

  const monday700 = {
    weekday: 1, hour: 7, minute: 0,
    weekYear: 2026, weekNumber: 19,
    toISODate: () => '2026-05-04',
    setZone() { return this; },
  };
  await weekly.checkAndRun(monday700);
  await weekly.checkAndRun(monday700);

  assert.equal(sends.length, 1, 'weekly report should send once for same ISO week');
  // Ensure ISO week key lookups still happened (claimed set has one entry)
  assert.equal(claimed.size, 1, 'single run-key claimed for this ISO week');
});

test('weekly reporter does not fire Tuesday 7:00 AM Chicago', async () => {
  const sends = [];
  const dbMock = {
    async claimServiceRun() { return true; },
    async getChatLogsForActiveDriverGroups() { return []; },
    async query() { return { rows: [] }; },
    async getInsightsForReport() { return []; },
    async updateAiReportStatus() {},
    async updateInsightStatus() {},
  };
  const botMock = { bot: { telegram: { async sendMessage() { sends.push(true); } } } };
  const weekly = loadWeeklyWithMocks(
    dbMock,
    botMock,
    { managementGroupId: '-100999' },
    { generateCompanyReport: async () => '<b>Weekly</b>', AI_REPORT_GENERATION_FAILED: 'AI_REPORT_GENERATION_FAILED' }
  );

  const tuesday700 = {
    weekday: 2, hour: 7, minute: 0,
    weekYear: 2026, weekNumber: 19,
    toISODate: () => '2026-05-05',
    setZone() { return this; },
  };
  await weekly.checkAndRun(tuesday700);
  assert.equal(sends.length, 0, 'weekly report must not send on Tuesday');
});
