/**
 * HTTP smoke tests for public routes: health (cron/Render), dispatch API, admin SPA fallback.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('fs');

process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.MANAGEMENT_GROUP_ID ||= '-1001234567890';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.PORT ||= '3001';

function loadAppWithDb(dbMock) {
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
      dispatchEtaTestGroupId: '',
      leadsInternalSharedSecret: 'internal-test-secret',
    },
  };
  require.cache[translationPath] = { exports: { translateBatch: async () => [] } };
  require.cache[aiPath] = {
    exports: {
      generateCompanyReport: async () => '',
      generateDriverReport: async () => '',
      AI_REPORT_GENERATION_FAILED: 'FAIL',
      callYandex: async () => '',
    },
  };
  require.cache[employeeVotingPath] = { exports: (req, res, next) => next() };
  require.cache[urlHelperPath] = { exports: { buildTelegramMessageUrl: () => 'https://t.me/c/123/1' } };

  return require(apiPath).app;
}

async function httpText(server, method, pathname) {
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}${pathname}`, { method });
  const text = method === 'HEAD' ? '' : await res.text();
  return { status: res.status, text, headers: res.headers };
}

async function httpJson(server, method, pathname) {
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}${pathname}`, { method });
  const json = res.headers.get('content-type')?.includes('application/json')
    ? await res.json()
    : null;
  return { status: res.status, json };
}

test('GET /api/health, /health, HEAD; dispatch /groups; admin SPA', async () => {
  const shared = { dbOk: true };
  const dbMock = {
    async ping() {
      return shared.dbOk;
    },
    async getAllDriverGroups() {
      return [{
        id: 1,
        group_name: 'Test Group',
        telegram_group_id: -1002,
        driver_first_name: 'D',
        driver_last_name: 'E',
      }];
    },
  };

  const app = loadAppWithDb(dbMock);
  const server = app.listen(0);

  const adminIndex = path.join(__dirname, '..', 'admin', 'build', 'index.html');
  const adminDir = path.dirname(adminIndex);
  let wroteAdminFixture = false;

  try {
    shared.dbOk = true;
    for (const p of ['/api/health', '/health']) {
      const { status, json } = await httpJson(server, 'GET', p);
      assert.equal(status, 200, p);
      assert.equal(json.healthy, true);
      assert.equal(json.db, true);
      assert.equal(json.status, 'ok');
      assert.equal(json.service, 'driver-feedback-bot');
      assert.ok(Number.isFinite(json.uptime));
    }

    const head = await httpText(server, 'HEAD', '/api/health');
    assert.equal(head.status, 200);
    assert.equal(head.text, '');

    shared.dbOk = false;
    const degraded = await httpJson(server, 'GET', '/health');
    assert.equal(degraded.status, 503);
    assert.equal(degraded.json.healthy, false);
    assert.equal(degraded.json.db, false);

    shared.dbOk = true;
    const dispatch = await httpJson(server, 'GET', '/api/dispatch/groups');
    assert.equal(dispatch.status, 200);
    assert.equal(dispatch.json.managementGroupId, '-1001');
    assert.equal(dispatch.json.groups.length, 1);
    assert.equal(dispatch.json.groups[0].group_name, 'Test Group');

    await fs.promises.mkdir(adminDir, { recursive: true });
    if (!fs.existsSync(adminIndex)) {
      await fs.promises.writeFile(
        adminIndex,
        '<!doctype html><html><head><title>t</title></head><body>fixture</body></html>',
        'utf8',
      );
      wroteAdminFixture = true;
    }

    const admin = await httpText(server, 'GET', '/admin');
    assert.equal(admin.status, 200);
    assert.match(admin.text, /fixture|html/i);

    const dispatchPage = await httpText(server, 'GET', '/dispatch');
    assert.equal(dispatchPage.status, 200);
    assert.match(dispatchPage.text, /fixture|html/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (wroteAdminFixture) {
      await fs.promises.unlink(adminIndex).catch(() => {});
      await fs.promises.rm(adminDir, { recursive: true }).catch(() => {});
    }
  }
});
