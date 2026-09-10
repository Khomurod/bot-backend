/**
 * /api/health carries an `operations` block: what the system is doing about
 * its own records, as counts.
 *
 * This is how a deploy is verified in production without a database
 * connection or an admin session — "did the background repair run, and what
 * did it find?" read off the same endpoint that names the commit. Two rules
 * hold it in place: the block is COUNTS AND TIMESTAMPS ONLY (no driver, chat,
 * key or finding title), and it can never make the endpoint itself unhealthy —
 * a summary that throws reads `available: false`, status 200.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const HEALTH_PATH = path.resolve(__dirname, '../server/routes/healthRoutes.js');
const { getOperationsHealth, scrubErrorText, ERROR_PREFIX_CHARS } = require('../services/operations/healthSummary');

function loadApp({ dbOk = true, getOperationsHealth: summary } = {}) {
  delete require.cache[HEALTH_PATH];
  const { createHealthRoutes } = require(HEALTH_PATH);
  const app = express();
  app.use(createHealthRoutes({
    db: { async ping() { return dbOk; } },
    config: { metaAppId: null, metaAppSecret: null },
    countExhaustedInternalAlerts: async () => ({ count: 0, oldestAt: null }),
    ...(summary === undefined ? {} : { getOperationsHealth: summary }),
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

const SAMPLE = { available: true, identity: { groupsWithoutPerson: 0, openUnits: 120 } };

test('the operations block is reported when a summary is injected and the database answers', async () => {
  const { status, json } = await getHealth(loadApp({ getOperationsHealth: async () => SAMPLE }));
  assert.equal(status, 200);
  assert.deepEqual(json.operations, SAMPLE);
});

test('no summary injected → no block, and nothing else changes', async () => {
  const { json } = await getHealth(loadApp({}));
  assert.equal('operations' in json, false);
  assert.equal(json.healthy, true);
});

test('a summary that throws reads available:false and leaves the status code alone', async () => {
  const { status, json } = await getHealth(loadApp({
    getOperationsHealth: async () => { throw new Error('relation "operational_findings" does not exist'); },
  }));
  assert.equal(status, 200, 'Render restarts on this code; a missing table is not a reason to');
  assert.equal(json.healthy, true);
  assert.equal(json.operations.available, false);
  assert.match(json.operations.error, /operational_findings/);
});

test('with the database down the block is withheld rather than guessed', async () => {
  const { json } = await getHealth(loadApp({ dbOk: false, getOperationsHealth: async () => SAMPLE }));
  assert.equal('operations' in json, false);
});

test('the block is cached briefly, so a health poller is not a query storm', async () => {
  let calls = 0;
  const app = loadApp({ getOperationsHealth: async () => { calls += 1; return SAMPLE; } });
  await getHealth(app);
  await getHealth(app);
  assert.equal(calls, 1);
});

// ─── the summary itself, with injected data-layer deps ───────────────────────

function summaryDeps(overrides = {}) {
  return {
    consistency: {
      getConsistencyStatus: () => ({
        running: true,
        lastRun: { at: '2026-09-10T12:00:00.000Z', summary: { found: 12, filed: 3, resolved: 4 } },
        lastCorrections: { at: '2026-09-10T12:00:01.000Z', summary: { applied: 65, stale: 0, failed: 0, capped: ['identity.group_without_person'] } },
      }),
    },
    findings: { async summariseFindings() { return { info: 1, warning: 2, serious: 0, total: 3 }; } },
    people: { async summariseIdentityCoverage() { return { people: 200, activeDriverGroups: 205, groupsWithoutPerson: 0, openUnits: 190, unstamped: { roadHistory: 0, requests: 0, mileage: 0 } }; } },
    integrity: { async countDuplicateOpenStays() { return []; }, async indexExists() { return true; } },
    aiProviders: {
      async listProvidersForAdmin() {
        return [
          { providerKey: 'gemini', enabled: true, modelChain: ['gemini-2.5-flash'], discoveredModels: [{ id: 'a' }, { id: 'b' }], modelsRefreshedAt: '2026-09-10T06:00:00.000Z', modelsRefreshError: null },
          { providerKey: 'groq', enabled: true, modelChain: ['x'], discoveredModels: [], modelsRefreshedAt: null, modelsRefreshError: `401 Unauthorized: ${'the provider said many words '.repeat(20)}` },
        ];
      },
    },
    ...overrides,
  };
}

test('the summary is counts and timestamps, with the capped list reduced to a number', async () => {
  const s = await getOperationsHealth(summaryDeps());
  assert.equal(s.available, true);
  assert.deepEqual(s.sweep, { running: true, lastRunAt: '2026-09-10T12:00:00.000Z', found: 12, filed: 3, resolved: 4 });
  assert.deepEqual(s.corrections, { at: '2026-09-10T12:00:01.000Z', applied: 65, stale: 0, failed: 0, capped: 1, error: null });
  assert.equal(s.identity.groupsWithoutPerson, 0);
  assert.deepEqual(s.homeTime, { groupsWithDuplicateOpenStays: 0, openStayIndex: 'present' });
  const gemini = s.aiModels.find((p) => p.provider === 'gemini');
  assert.deepEqual(gemini, { provider: 'gemini', enabled: true, chain: 1, discovered: 2, refreshedAt: '2026-09-10T06:00:00.000Z', refreshError: null });
});

test('a provider\'s listing error is a short prefix — enough to see WHY, never the whole body', async () => {
  const s = await getOperationsHealth(summaryDeps());
  const groq = s.aiModels.find((p) => p.provider === 'groq');
  assert.equal(groq.refreshError.length, ERROR_PREFIX_CHARS);
  assert.match(groq.refreshError, /^401 Unauthorized/);
});

test('a credential echoed in a provider\'s error never reaches the public endpoint', async () => {
  // /api/health needs no login. The provider's words are kept; anything shaped
  // like a key is not, and the scrub runs before the cut so a truncated key
  // cannot pass as a shorter one.
  const key = `AIza${'Q'.repeat(35)}`;
  const s = await getOperationsHealth(summaryDeps({
    aiProviders: {
      async listProvidersForAdmin() {
        return [{ providerKey: 'gemini', enabled: true, modelChain: [], discoveredModels: [],
          modelsRefreshedAt: null, modelsRefreshError: `400 API key not valid: ${key} (https://x/models?key=${key})` }];
      },
    },
  }));
  const text = s.aiModels[0].refreshError;
  assert.equal(text.includes(key), false);
  assert.equal(text.includes(key.slice(0, 20)), false, 'nor a prefix of it');
  assert.match(text, /^400 API key not valid/);
  assert.equal(scrubErrorText('401 Unauthorized: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'), '401 Unauthorized: [redacted]');
  assert.equal(scrubErrorText('gsk_' + 'a'.repeat(40) + ' was rejected'), '[redacted] was rejected');
  assert.equal(scrubErrorText('No Base URL to list models from'), 'No Base URL to list models from', 'ordinary words pass');
});

test('the summary never carries a name, a title or a chat id', async () => {
  const s = await getOperationsHealth(summaryDeps());
  const text = JSON.stringify(s);
  for (const forbidden of ['title', 'groupName', 'group_name', 'telegram', 'apiKey', 'api_key', 'displayName']) {
    assert.equal(text.includes(forbidden), false, `${forbidden} must not appear in a health payload`);
  }
});

test('before the first sweep the block is zeros and nulls, not an error', async () => {
  const s = await getOperationsHealth(summaryDeps({
    consistency: { getConsistencyStatus: () => ({ running: true, lastRun: null, lastCorrections: null }) },
  }));
  assert.equal(s.available, true);
  assert.deepEqual(s.sweep, { running: true, lastRunAt: null, found: null, filed: null, resolved: null });
  assert.equal(s.corrections, null);
});

test('a data-layer failure reads available:false with the reason', async () => {
  const s = await getOperationsHealth(summaryDeps({
    integrity: { async countDuplicateOpenStays() { throw new Error('connection refused'); }, async indexExists() { return false; } },
  }));
  assert.deepEqual(s, { available: false, error: 'connection refused' });
});
