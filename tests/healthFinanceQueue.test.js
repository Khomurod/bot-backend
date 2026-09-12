'use strict';

/**
 * /api/health reports the finance document queue.
 *
 * Same lesson as the alert outbox this block was built for: a queue nobody
 * drains fails silently, and payment evidence piling up unread is not something
 * anybody notices by looking. `needs_review` is not an error — it is work
 * waiting for a person — but `failed` means documents Wenze could not fetch at
 * all, and a number that only goes up is worth being able to see.
 *
 * THE LOAD-BEARING ASSERTION IS THE NEGATIVE ONE: none of this may change the
 * status code. Render and the uptime monitor read that, and a backlog of
 * receipts is an operator's problem, not a reason to cycle the service.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const HEALTH_PATH = path.resolve(__dirname, '../server/routes/healthRoutes.js');

function loadApp({ summarise = null, dbOk = true } = {}) {
  delete require.cache[HEALTH_PATH];
  const { createHealthRoutes } = require(HEALTH_PATH);
  const app = express();
  app.use(createHealthRoutes({
    db: { async ping() { return dbOk; } },
    config: { metaAppId: null, metaAppSecret: null },
    summariseFinanceDocuments: summarise,
  }));
  return app;
}

async function getHealth(app) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/health`);
    return { status: res.status, json: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const quiet = async (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { console.warn = warn; }
};

test('the queue is reported with counts, and never changes the status code', async () => {
  const app = loadApp({
    summarise: async () => ({
      available: true,
      byStatus: { read: 40, pending: 3, needs_review: 7, failed: 2 },
      total: 52, needsReview: 7, failed: 2,
    }),
  });
  const { status, json } = await quiet(() => getHealth(app));

  assert.equal(status, 200, 'a backlog of receipts is not a reason to cycle the service');
  assert.deepEqual(json.queues.financeDocuments, {
    available: true, pending: 3, needsReview: 7, failed: 2, read: 40,
  });
});

test('COUNTS ONLY — nothing about what any document says', async () => {
  const app = loadApp({
    summarise: async () => ({
      available: true, byStatus: { read: 1 }, total: 1, needsReview: 0, failed: 0,
    }),
  });
  const { json } = await getHealth(app);

  // /api/health is unauthenticated. Structural, so the shape can grow.
  const flat = JSON.stringify(json.queues.financeDocuments);
  for (const forbidden of ['file', 'caption', 'amount', 'code', 'extracted', 'chat']) {
    assert.ok(!flat.toLowerCase().includes(forbidden), `the health block leaked "${forbidden}"`);
  }
});

test('the table not being there yet is "unavailable", not zero', async () => {
  const app = loadApp({
    summarise: async () => ({ available: false, byStatus: {}, total: 0, needsReview: 0, failed: 0 }),
  });
  const { json } = await getHealth(app);
  assert.equal(json.queues.financeDocuments.available, false,
    '"nothing captured" and "the feature has not been deployed" are different answers');
});

test('a failing summary never breaks the health endpoint itself', async () => {
  const app = loadApp({ summarise: async () => { throw new Error('connection refused'); } });
  const { status, json } = await getHealth(app);
  assert.equal(status, 200);
  assert.equal(json.queues.financeDocuments.available, false);
  assert.match(json.queues.financeDocuments.error, /connection refused/);
});

test('with nothing injected the block is absent-but-honest, not invented', async () => {
  const app = loadApp({ summarise: null });
  const { json } = await getHealth(app);
  assert.equal(json.queues.financeDocuments.available, false);
});
