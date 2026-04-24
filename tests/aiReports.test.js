const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');

function loadApiWithMocks(dbMock, aiMock) {
  const apiPath = path.resolve(__dirname, '../server/api.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const botPath = path.resolve(__dirname, '../bot/bot.js');
  const configPath = path.resolve(__dirname, '../config/config.js');
  const translationPath = path.resolve(__dirname, '../services/translationService.js');
  const aiPath = path.resolve(__dirname, '../services/aiAnalysisService.js');
  const employeeVotingPath = path.resolve(__dirname, '../server/employeeVotingApi.js');
  const urlHelperPath = path.resolve(__dirname, '../services/telegramUrl.js');

  delete require.cache[apiPath];
  delete require.cache[dbPath];
  delete require.cache[botPath];
  delete require.cache[configPath];
  delete require.cache[translationPath];
  delete require.cache[aiPath];
  delete require.cache[employeeVotingPath];
  delete require.cache[urlHelperPath];

  require.cache[dbPath] = { exports: dbMock };
  require.cache[botPath] = {
    exports: {
      bot: { telegram: { async sendMessage() {} } },
      sendQuestionToGroups: async () => ({ sent: 0, failed: 0 }),
      sendTestQuestion: async () => ({}),
      sendBroadcast: async () => ({ sent: 0, failed: 0 }),
      sendBroadcastTest: async () => ({}),
      sendBroadcastToGroups: async () => ({ sent: 0, failed: 0 }),
      sendConfirmationBroadcast: async () => ({ sent: 0, failed: 0 }),
      sendConfirmationBroadcastTest: async () => ({}),
    },
  };
  require.cache[configPath] = {
    exports: {
      jwtSecret: 'test-secret',
      managementGroupId: '-1001',
      port: 0,
      corsAllowAll: true,
      corsAllowedOrigins: [],
    },
  };
  require.cache[translationPath] = { exports: { translateBatch: async () => [] } };
  require.cache[aiPath] = { exports: aiMock };
  require.cache[employeeVotingPath] = { exports: (req, res, next) => next() };
  require.cache[urlHelperPath] = { exports: { buildTelegramMessageUrl: () => 'https://t.me/c/123/1' } };

  const apiModule = require(apiPath);
  const { app } = apiModule;
  return { app, aiMock };
}

async function requestJson(server, token, pathName, body) {
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}${pathName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

test('api /ai-reports/generate routes company and driver correctly', async () => {
  const calls = {
    globalLogs: 0,
    groupLogs: 0,
    groupValidation: 0,
    driverGenerate: 0,
    companyGenerate: 0,
  };

  const dbMock = {
    async getChatLogsForActiveDriverGroups() {
      calls.globalLogs += 1;
      return [{ message_text: 'global', sender_name: 'S', group_name: 'G', telegram_group_id: -1001, telegram_message_id: 1, created_at: new Date() }];
    },
    async getChatLogsForGroup() {
      calls.groupLogs += 1;
      return [{ message_text: 'driver', sender_name: 'D', group_name: 'DG', telegram_group_id: -1002, telegram_message_id: 2, created_at: new Date() }];
    },
    async saveAiReport(groupId, text, type) {
      return { id: type === 'company' ? 1 : 2, group_id: groupId, report_text: text, report_type: type };
    },
    async getAiReportById(id) {
      return { id, status: 'draft', report_type: id === 1 ? 'company' : 'driver' };
    },
    async query(sql) {
      if (sql.includes('FROM groups')) {
        calls.groupValidation += 1;
        return { rows: [{ id: 88, group_name: 'Driver Group' }] };
      }
      return { rows: [] };
    },
  };

  const aiMock = {
    generateCompanyReport: async () => { calls.companyGenerate += 1; return '<b>Company</b>'; },
    generateDriverReport: async () => { calls.driverGenerate += 1; return 'Overall|||Breakdown'; },
    AI_REPORT_GENERATION_FAILED: 'AI_REPORT_GENERATION_FAILED',
    callYandex: async () => 'YANDEX_OK',
  };

  const { app } = loadApiWithMocks(dbMock, aiMock);
  const server = app.listen(0);
  const token = jwt.sign({ id: 1, username: 'admin' }, 'test-secret');

  try {
    const companyRes = await requestJson(server, token, '/api/ai-reports/generate', {
      reportType: 'company',
      daysBack: 7,
    });
    assert.equal(companyRes.status, 201);
    assert.equal(calls.globalLogs, 1);
    assert.equal(calls.groupValidation, 0, 'company route should bypass group validation');
    assert.equal(calls.companyGenerate, 1);

    const driverRes = await requestJson(server, token, '/api/ai-reports/generate', {
      reportType: 'driver',
      groupId: 88,
      daysBack: 7,
    });
    assert.equal(driverRes.status, 201);
    assert.equal(calls.groupValidation, 1, 'driver route should validate specific group');
    assert.equal(calls.groupLogs, 1, 'driver route should query single-group logs');
    assert.equal(calls.driverGenerate, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
