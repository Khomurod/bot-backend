'use strict';

/**
 * Economy mode, where it touches the rest of the application: the ledger
 * wrapper, the health endpoint, the database pool and the AI roster.
 *
 * Each of these was a measured line in the October 2026 transfer audit: the
 * operations block built for every cron ping, a connection reopened (TLS and
 * all) after thirty idle seconds, and the AI roster re-reading every provider
 * row — OpenRouter's 43 KB model listing included — every thirty seconds.
 */
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const resolve = (p) => path.resolve(__dirname, p);
const ECONOMY = resolve('../services/operations/economy.js');
const LEDGER = resolve('../services/operations/runLedger.js');
const RUNS = resolve('../database/backgroundRuns.js');
const HEALTH = resolve('../server/routes/healthRoutes.js');
const POOL = resolve('../database/pool.js');
const REGISTRY = resolve('../services/ai/registry.js');
const ROUTER = resolve('../services/ai/router.js');
const GATE = resolve('../services/ai/capabilityGate.js');
const PROVIDERS = resolve('../database/aiProviders.js');
const SETTINGS = resolve('../database/aiSettings.js');
const CALL_LOG = resolve('../database/aiCallLog.js');
const OPENAI = resolve('../services/ai/adapters/openaiChat.js');
const GEMINI = resolve('../services/ai/adapters/gemini.js');

function withEconomy(t, value) {
  const before = process.env.ECONOMY_MODE_UNTIL;
  if (value === undefined) delete process.env.ECONOMY_MODE_UNTIL;
  else process.env.ECONOMY_MODE_UNTIL = value;
  t.after(() => {
    if (before === undefined) delete process.env.ECONOMY_MODE_UNTIL;
    else process.env.ECONOMY_MODE_UNTIL = before;
  });
}

const FUTURE = () => new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();

// ─── the ledger wrapper ──────────────────────────────────────────────────────

function loadLedger() {
  const writes = [];
  for (const p of [LEDGER, ECONOMY]) delete require.cache[p];
  require.cache[RUNS] = {
    exports: {
      async recordRunStart(key) { writes.push(['start', key]); return true; },
      async recordRunFinish(key, args) { writes.push(['finish', key, args.status]); return true; },
    },
  };
  // eslint-disable-next-line global-require
  const ledger = require(LEDGER);
  delete require.cache[RUNS];
  return { ledger, writes };
}

test('A PAUSED PASS DOES NOT RUN AND WRITES NOTHING — not even its start line', async (t) => {
  withEconomy(t, FUTURE());
  const { ledger, writes } = loadLedger();
  let ran = false;
  const out = await ledger.withRunRecord('consistency_sweep', async () => { ran = true; return {}; });
  assert.equal(ran, false);
  assert.equal(out.economy, true);
  assert.match(out.blocked, /^paused to save database traffic until /);
  assert.deepEqual(writes, [], 'the point is to reach the database less');
});

test('a pass that is not paused runs exactly as before, ledger and all', async (t) => {
  withEconomy(t, FUTURE());
  const { ledger, writes } = loadLedger();
  const out = await ledger.withRunRecord('notification_drain', async () => ({ sent: 2 }));
  assert.deepEqual(out, { sent: 2 });
  assert.deepEqual(writes, [['start', 'notification_drain'], ['finish', 'notification_drain', 'ok']]);
});

test('with the switch off, a pause-list pass runs as before', async (t) => {
  withEconomy(t, undefined);
  const { ledger, writes } = loadLedger();
  const out = await ledger.withRunRecord('consistency_sweep', async () => ({ checked: 1 }));
  assert.deepEqual(out, { checked: 1 });
  assert.equal(writes.length, 2);
});

// ─── the health endpoint ─────────────────────────────────────────────────────

async function health({ economyState, operations }) {
  delete require.cache[HEALTH];
  // eslint-disable-next-line global-require
  const { createHealthRoutes } = require(HEALTH);
  const app = express();
  let built = 0;
  app.use(createHealthRoutes({
    db: { async ping() { return true; } },
    config: { metaAppId: null, metaAppSecret: null },
    countExhaustedInternalAlerts: async () => ({ count: 0, oldestAt: null }),
    getOperationsHealth: async () => { built += 1; return operations; },
    getEconomyState: () => economyState,
  }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    return { status: res.status, json: await res.json(), built };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('IN ECONOMY MODE the operations block is not built, and the body says why', async () => {
  const { status, json, built } = await health({
    economyState: { active: true, until: '2026-10-21T00:00:00.000Z' },
    operations: { available: true },
  });
  assert.equal(status, 200, 'a deliberate skip never makes the endpoint unhealthy');
  assert.equal(built, 0, 'the most expensive read in the application is not made');
  assert.equal(json.operations, undefined);
  assert.deepEqual(json.economy, { active: true, until: '2026-10-21T00:00:00.000Z' });
});

test('with economy mode off the operations block is reported as before', async () => {
  const { json, built } = await health({ economyState: { active: false }, operations: { available: true } });
  assert.equal(built, 1);
  assert.deepEqual(json.operations, { available: true });
  assert.equal(json.economy, undefined);
});

// ─── the database pool ───────────────────────────────────────────────────────

test('IDLE CONNECTIONS ARE KEPT TEN MINUTES, with TCP keepalive — a reconnect is metered egress', (t) => {
  const pgPath = require.resolve('pg');
  const before = process.env.PG_IDLE_TIMEOUT_MS;
  delete process.env.PG_IDLE_TIMEOUT_MS;
  let options = null;
  delete require.cache[POOL];
  require.cache[pgPath] = { exports: { Pool: class { constructor(o) { options = o; } on() {} } } };
  t.after(() => {
    delete require.cache[pgPath];
    delete require.cache[POOL];
    if (before !== undefined) process.env.PG_IDLE_TIMEOUT_MS = before;
  });
  // eslint-disable-next-line global-require
  require(POOL);
  assert.equal(options.idleTimeoutMillis, 600000);
  assert.equal(options.keepAlive, true);
  assert.equal(options.keepAliveInitialDelayMillis, 60000);
});

// ─── the AI roster ───────────────────────────────────────────────────────────

function stubAi({ providers, listing, failFirstModel = false }) {
  const reads = { providers: 0, listing: 0, cooled: [] };
  for (const p of [ROUTER, REGISTRY, GATE]) delete require.cache[p];
  require.cache[PROVIDERS] = {
    exports: {
      async getProvidersForRouter() { reads.providers += 1; return providers.map((p) => ({ ...p })); },
      async getDiscoveredModelIdsForRouter() { reads.listing += 1; return new Map(listing); },
      async recordSuccess() {},
      async recordFailure(key) { reads.cooled.push(key); },
    },
  };
  require.cache[SETTINGS] = {
    exports: {
      DEFAULTS: {},
      invalidateCache() {},
      async listCapabilities() { return []; },
      async getAiSettings() {
        return { enabled: true, freeOnlyMode: false, routingMode: 'priority', requestTimeoutMs: 1000, maxRetryWaitMs: 5000 };
      },
    },
  };
  require.cache[CALL_LOG] = { exports: { async recordAiCall() {} } };
  const adapter = async ({ model }) => {
    if (failFirstModel && model === 'm-a') {
      const err = new Error('You exceeded your current quota');
      err.status = 429;
      throw err;
    }
    return { text: 'ok', model, payload: {}, usage: null };
  };
  require.cache[OPENAI] = { exports: { callOpenAiChat: adapter, DEFAULT_TIMEOUT_MS: 1000 } };
  require.cache[GEMINI] = { exports: { callGeminiGenerate: adapter, DEFAULT_TIMEOUT_MS: 1000 } };
  return reads;
}

const PROVIDER = (over = {}) => ({
  providerKey: 'groq', adapter: 'openai_chat', enabled: true, isFree: true, priority: 1,
  baseUrl: 'https://example.invalid/v1', modelChain: ['m-a'], apiKey: 'k',
  cooledUntil: null, consecutiveFailures: 0, ...over,
});

test('the model listing is read separately and kept far longer than the roster', async () => {
  const reads = stubAi({ providers: [PROVIDER()], listing: [['groq', ['m-a', 'm-b']]] });
  // eslint-disable-next-line global-require
  const registry = require(REGISTRY);
  const roster = await registry.getRoster();
  assert.deepEqual(roster.providers[0].discoveredModelIds, ['m-a', 'm-b']);
  await registry.getRoster();
  assert.deepEqual(reads, { providers: 1, listing: 1, cooled: [] }, 'cached, not re-read per call');
  assert.ok(registry.CACHE_TTL_MS >= 10 * 60 * 1000);
  assert.ok(registry.LISTING_TTL_MS > registry.CACHE_TTL_MS);

  registry.invalidateProviders();
  await registry.getRoster();
  assert.equal(reads.providers, 2);
  assert.equal(reads.listing, 1, 'a provider-state change does not re-read the listing');

  registry.invalidateRegistry();
  await registry.getRoster();
  assert.equal(reads.listing, 2, 'a refresh or an admin save re-reads everything');
});

test('A PROVIDER PUT ON COOLDOWN IS NOT ASKED AGAIN on the strength of a cached roster', async () => {
  const reads = stubAi({
    providers: [PROVIDER(), PROVIDER({ providerKey: 'cerebras', priority: 2, modelChain: ['m-b'] })],
    listing: [],
    failFirstModel: true,
  });
  // eslint-disable-next-line global-require
  const router = require(ROUTER);
  const first = await router.runCapability({ userText: 'hi' });
  assert.equal(first.provider, 'cerebras');
  assert.deepEqual(reads.cooled, ['groq']);
  assert.equal(reads.providers, 1);
  await router.runCapability({ userText: 'hi again' });
  assert.equal(reads.providers, 2, 'the roster was re-read after the cooldown was written');
});

test('A DATABASE BLIP SWITCHES AI OFF FOR SECONDS, not for the whole ten-minute window', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-09T18:00:00Z') });
  const reads = stubAi({ providers: [PROVIDER()], listing: [] });
  let fail = true;
  require.cache[PROVIDERS].exports.getProvidersForRouter = async () => {
    reads.providers += 1;
    if (fail) throw new Error('connection terminated');
    return [PROVIDER()];
  };
  // eslint-disable-next-line global-require
  const registry = require(REGISTRY);
  assert.equal((await registry.getRoster()).available, false);
  fail = false;
  t.mock.timers.tick(registry.FAILED_READ_TTL_MS + 1);
  assert.equal((await registry.getRoster()).available, true, 'the next read after the short window succeeds');
  assert.equal(reads.providers, 2);
});

test('A SUCCESS CLEARS THE CACHED FAILURE COUNT — the next failure is counted from zero', async () => {
  const reads = stubAi({ providers: [PROVIDER({ consecutiveFailures: 3, cooldownReason: 'rate limited' })], listing: [] });
  // eslint-disable-next-line global-require
  const router = require(ROUTER);
  // eslint-disable-next-line global-require
  const registry = require(REGISTRY);
  await router.runCapability({ userText: 'hi' });
  const [p] = (await registry.getRoster()).providers;
  assert.equal(p.consecutiveFailures, 0, 'what recordSuccess wrote is what the cache now says');
  assert.equal(p.cooldownReason, null);
  assert.equal(reads.providers, 1, 'applied in place, not by re-reading every provider');
});

// ─── the Dispatcher Board read ───────────────────────────────────────────────

const POLLER = resolve('../services/dispatchBoard/poller.js');

function loadPoller() {
  for (const p of [POLLER, LEDGER, ECONOMY]) delete require.cache[p];
  require.cache[RUNS] = { exports: { async recordRunStart() { return true; }, async recordRunFinish() { return true; } } };
  // eslint-disable-next-line global-require
  const poller = require(POLLER);
  delete require.cache[RUNS];
  return poller;
}

function boardDeps(results) {
  const calls = { fetch: 0 };
  const deps = {
    settings: {
      getBoardConfig: async () => ({
        enabled: true, configured: true, baseUrl: 'https://script.example.test/exec', token: 't', pollIntervalSeconds: 300,
      }),
      recordPollOutcome: async () => null,
    },
    client: {
      fetchBoard: async () => {
        const ok = results[calls.fetch] !== 'fail';
        calls.fetch += 1;
        if (!ok) throw new Error('fetch failed');
        return { json: { rows: [{ driver: 'ALPHA ONE', truck: '001' }] } };
      },
    },
    store: { applyBoardPass: async () => ({ inserted: 1, updated: 0, unchanged: 0, skipped: 0, absent: 0 }) },
  };
  return { deps, calls };
}

const settle = () => new Promise((r) => setImmediate(r));

test('IN ECONOMY MODE a failed Board read retries in five minutes — a good one waits four hours', async (t) => {
  withEconomy(t, FUTURE());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const poller = loadPoller();
  const { deps, calls } = boardDeps(['fail', 'ok', 'ok']);
  poller.startDispatchBoardPoller(deps);
  t.after(() => poller.stopDispatchBoardPoller());

  t.mock.timers.tick(poller.FIRST_TICK_DELAY_MS); await settle();
  assert.equal(calls.fetch, 1, 'the first read failed');
  t.mock.timers.tick(5 * 60 * 1000); await settle();
  assert.equal(calls.fetch, 2, 'retried at the normal pace, not four hours later');
  t.mock.timers.tick(5 * 60 * 1000); await settle();
  assert.equal(calls.fetch, 2, 'after a good read it waits');
  t.mock.timers.tick(4 * 60 * 60 * 1000 - 5 * 60 * 1000); await settle();
  assert.equal(calls.fetch, 3, 'four hours after the good read');
});
