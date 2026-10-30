/**
 * HTTP smoke tests for public routes: health (cron/Render), the removed
 * dispatch APIs, the retired Dispatch Center page, admin SPA fallback.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('fs');
const jwt = require('jsonwebtoken');

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
  const urlHelperPath = path.resolve(__dirname, '../services/telegramUrl.js');

  delete require.cache[apiPath];
  delete require.cache[dbPath];
  delete require.cache[botPath];
  delete require.cache[configPath];
  delete require.cache[translationPath];
  delete require.cache[aiPath];
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
      leadsInternalSharedSecret: 'internal-test-secret',
    },
  };
  require.cache[translationPath] = { exports: { translateBatch: async () => [] } };
  require.cache[aiPath] = {
    exports: {
      generateCompanyReport: async () => '',
      generateDriverReport: async () => '',
      AI_REPORT_GENERATION_FAILED: 'FAIL',
      callGroq: async () => '',
    },
  };
  require.cache[urlHelperPath] = { exports: { buildTelegramMessageUrl: () => 'https://t.me/c/123/1' } };

  return require(apiPath).app;
}

async function httpText(server, method, pathname) {
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}${pathname}`, { method });
  const text = method === 'HEAD' ? '' : await res.text();
  return { status: res.status, text, headers: res.headers };
}

async function httpJson(server, method, pathname, headers = {}) {
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}${pathname}`, { method, headers });
  const json = res.headers.get('content-type')?.includes('application/json')
    ? await res.json()
    : null;
  return { status: res.status, json };
}

test('GET /api/health, /health, HEAD; the removed dispatch APIs; the race displays; the retired /dispatch/* pages; admin SPA', async () => {
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
    // `getAllDriverGroups` above belonged to the removed Send Load group list
    // and is kept only so the 404s below prove the routes are gone rather than
    // that their data source is.
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
    // `/api/dispatch/testing-feature/*` was the dispatcher ETA testing panel and
    // went with the ETA feature (October 2026); `/api/dispatch/groups` was the
    // Send Load tab's "whose chat do I send this to" list and went with the
    // Dispatch Center. ASSERTED WITH A VALID TOKEN, so a 401 from some other
    // guard cannot pass for "the route is gone".
    const adminToken = jwt.sign({ id: 1, username: 'admin' }, 'test-secret', { algorithm: 'HS256' });
    const retiredEta = await httpJson(server, 'GET', '/api/dispatch/testing-feature/groups', {
      Authorization: `Bearer ${adminToken}`,
    });
    assert.equal(retiredEta.status, 404, 'the ETA testing panel API is gone');

    const retiredSendTarget = await httpJson(server, 'GET', '/api/dispatch/groups', {
      Authorization: `Bearer ${adminToken}`,
    });
    assert.equal(retiredSendTarget.status, 404, 'the Send Load group list is gone');

    // The Finance page and Settings -> Finance went with the Finance Monitor
    // (October 2026). Same rule: a valid token, so only "gone" can answer 404.
    for (const retiredFinance of ['/api/finance/messages', '/api/settings/finance/status']) {
      const res = await httpJson(server, 'GET', retiredFinance, { Authorization: `Bearer ${adminToken}` });
      assert.equal(res.status, 404, `${retiredFinance} is gone`);
    }

    // Routes no screen called, removed after the October 2026 audit: AI
    // Reports / Insights, the old driver-group writes and lists, the AI
    // status "run now", the old profile AI parse, one correction's detail,
    // a knowledge entry's history, the music download, and the root-level
    // webhook-log duplicates. Same rule: a valid token, so only "gone" is 404.
    for (const [method, retired] of [
      ['GET', '/api/ai-reports'], ['POST', '/api/ai-reports/generate'],
      ['GET', '/api/ai-insights/reports'], ['POST', '/api/ai-insights/annotate'],
      ['GET', '/api/groups'], ['GET', '/api/groups/driver-list'],
      ['POST', '/api/groups/status/run-now'], ['PUT', '/api/groups/1/language'],
      ['PUT', '/api/groups/1/birthday'], ['PUT', '/api/groups/1/status'],
      ['POST', '/api/driver-profiles/ai-parse'],
      ['GET', '/api/operations/corrections/1'],
      ['GET', '/api/recruiting-knowledge/1/history'],
      ['GET', '/api/settings/safety-events/music/1/download'],
      ['GET', '/leads-log'], ['GET', '/retry/1'],
    ]) {
      const res = await httpJson(server, method, retired, { Authorization: `Bearer ${adminToken}` });
      assert.equal(res.status, 404, `${method} ${retired} is gone`);
    }
    // The control: their live neighbours still answer, so the 404s above are
    // "removed", not a harness that 404s everything.
    for (const live of ['/api/groups/manage', '/api/facebook-leads/webhook-log', '/api/recruiting-knowledge']) {
      const res = await httpJson(server, 'GET', live, { Authorization: `Bearer ${adminToken}` });
      assert.notEqual(res.status, 404, `${live} is still mounted`);
    }

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

    // `/dispatch` and `/dispatchteam` are the Gross Grand Prix displays, public
    // pages of the shell like `/recruiters`.
    for (const racePath of ['/dispatch', '/dispatchteam']) {
      const racePage = await httpText(server, 'GET', racePath);
      assert.equal(racePage.status, 200, racePath);
      assert.match(racePage.text, /fixture|html/i, racePath);
    }

    // THE RETIRED PAGE ANSWERS 410, NOT THE SHELL. A deep link into the old
    // Dispatch Center gets "this feature has been removed" instead of the shell
    // finding no such section and silently rendering Driver Groups.
    const dispatchPage = await httpText(server, 'GET', '/dispatch/loads');
    assert.equal(dispatchPage.status, 410);
    assert.match(dispatchPage.text, /removed/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (wroteAdminFixture) {
      await fs.promises.unlink(adminIndex).catch(() => {});
      await fs.promises.rm(adminDir, { recursive: true }).catch(() => {});
    }
  }
});
