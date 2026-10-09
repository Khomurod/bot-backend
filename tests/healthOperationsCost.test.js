'use strict';

/**
 * What /api/health's operations block costs the database, and how often.
 *
 * October 2026, with the hosted database's monthly transfer allowance nearly
 * spent: Render's own health check polls this path. The block was rebuilt up
 * to once a minute, and each build read every AI provider whole, including the
 * model listing (about 43 KB for OpenRouter's) of which it reports only the
 * count. A HEAD request built it too, for a body nobody receives.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const sent = [];
const textOf = (q) => (typeof q === 'string' ? q : q?.text || '');
class FakePool {
  on() {}
  async query(q) { sent.push(textOf(q)); return { rows: [], rowCount: 0 }; }
  async connect() { return { query: async (q) => { sent.push(textOf(q)); return { rows: [], rowCount: 0 }; }, release() {} }; }
}
require.cache[require.resolve('pg')] = { exports: { Pool: FakePool } };

const HEALTH = path.resolve(__dirname, '../server/routes/healthRoutes.js');

test('ONE BUILD never reads a provider\'s model listing — only its size', async () => {
  // eslint-disable-next-line global-require
  const { getOperationsHealth } = require('../services/operations/healthSummary');
  sent.length = 0;
  const block = await getOperationsHealth();
  assert.equal(block.available, true, block.error);
  const providerReads = sent.map((s) => s.replace(/\s+/g, ' ')).filter((s) => /FROM ai_providers/.test(s));
  assert.ok(providerReads.length > 0);
  for (const s of providerReads) {
    assert.doesNotMatch(s, /SELECT \*/, s);
    assert.doesNotMatch(s, /discovered_models[,\s]+(?!ELSE|THEN)/, `the listing itself is read: ${s}`);
  }
});

async function serve(t) {
  delete require.cache[HEALTH];
  // eslint-disable-next-line global-require
  const { createHealthRoutes } = require(HEALTH);
  let built = 0;
  const app = express();
  app.use(createHealthRoutes({
    db: { async ping() { return true; } },
    config: { metaAppId: null, metaAppSecret: null },
    countExhaustedInternalAlerts: async () => ({ count: 0, oldestAt: null }),
    getOperationsHealth: async () => { built += 1; return { available: true }; },
    getEconomyState: () => ({ active: false }),
  }));
  const server = app.listen(0);
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}/api/health`;
  return { url, built: () => built };
}

test('a HEAD request does not build the operations block — nobody receives the body', async (t) => {
  const { url, built } = await serve(t);
  const res = await fetch(url, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(built(), 0);
});

test('the block is built once per FIFTEEN minutes, however often the health check polls', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T00:00:00Z') });
  const { url, built } = await serve(t);
  await fetch(url);
  t.mock.timers.tick(14 * 60 * 1000);
  const second = await (await fetch(url)).json();
  assert.equal(built(), 1, 'fourteen minutes later the counts are served from the cache');
  assert.deepEqual(second.operations, { available: true });
  t.mock.timers.tick(60 * 1000);
  await fetch(url);
  assert.equal(built(), 2, 'and rebuilt after fifteen');
});
