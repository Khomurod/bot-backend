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
const { getOperationsHealth, describeRefreshError, REFRESH_ERROR_KINDS } = require('../services/operations/healthSummary');

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
        lastCorrections: { at: '2026-09-10T12:00:01.000Z', summary: { applied: 65, stale: 0, failed: 0, capped: [{ checkKey: 'identity.group_without_person', wanted: 151, cap: 150, findingId: 9 }] } },
      }),
    },
    findings: { async summariseFindings() { return { info: 1, warning: 2, serious: 0, total: 3 }; } },
    people: { async summariseIdentityCoverage() { return { people: 200, activeDriverGroups: 205, groupsWithoutPerson: 0, openUnits: 190, unstamped: { roadHistory: 0, requests: 0, mileage: 0 } }; } },
    integrity: { async countDuplicateOpenStays() { return []; }, async indexExists() { return true; } },
    // The live Home Time block is composed in, so it is faked in.
    homeTimeHealth: {
      async getHomeTimeHealth() {
        return {
          available: true,
          returnWatch: { watching: 2, anchored: 2, high: 0, medium: 1, low: 1, lastCheckedAt: '2026-09-10T12:00:00.000Z', oldestCheckedAt: '2026-09-10T11:48:00.000Z' },
          managerNotices: { arrived_home: { rows: 3, events: 3, delivered: 3, pending: 0, failed: 0, abandoned: 0 } },
          requestsByStatus: { recorded: 4, pending: 79 },
          automaticReturns: { applied: 1, reverted: 0, lastAppliedAt: '2026-09-10T11:00:00.000Z' },
          aiResponsibilities: { registered: 17, switchedOff: 0, mayAutoApply: 0 },
        };
      },
    },
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

test('the summary is counts and timestamps, and a capped check is named with its numbers', async () => {
  const s = await getOperationsHealth(summaryDeps());
  assert.equal(s.available, true);
  assert.deepEqual(s.sweep, { running: true, lastRunAt: '2026-09-10T12:00:00.000Z', found: 12, filed: 3, resolved: 4 });
  assert.deepEqual(s.corrections, {
    at: '2026-09-10T12:00:01.000Z', applied: 65, stale: 0, failed: 0, error: null,
    // WHICH check stopped itself, and by how much — check keys are code
    // identifiers, and without this a capped pass reads "0 applied" with no why.
    capped: [{ checkKey: 'identity.group_without_person', wanted: 151, cap: 150 }],
  });
  assert.equal(s.identity.groupsWithoutPerson, 0);
  // The invariant, plus what the feature is actually DOING. The live half is
  // composed in from services/operations/homeTimeHealth.js and covered in
  // tests/homeTimeHealthBlock.test.js; here it only has to arrive intact.
  assert.equal(s.homeTime.groupsWithDuplicateOpenStays, 0);
  assert.equal(s.homeTime.openStayIndex, 'present');
  assert.equal(s.homeTime.available, true);
  assert.equal(s.homeTime.returnWatch.watching, 2);
  assert.equal(s.homeTime.automaticReturns.applied, 1);
  assert.equal(s.homeTime.aiResponsibilities.registered, 17);
  const gemini = s.aiModels.find((p) => p.provider === 'gemini');
  assert.deepEqual(gemini, { provider: 'gemini', enabled: true, chain: 1, discovered: 2, refreshedAt: '2026-09-10T06:00:00.000Z', refreshError: null });
});

test('a provider\'s listing error is published as a status and a kind — never its text', async () => {
  // /api/health needs no login, and the error text is the PROVIDER's: it can
  // carry a key echoed in a body, an `authorization: …` line, a `"api_key":"…"`
  // field. No pattern list is trusted to find every shape, so none of the
  // text leaves. What does: the HTTP status the provider answered with, and a
  // word from a closed vocabulary — enough to see WHY ("credential" says the
  // key is dead; "not_configured" says discovery has nowhere to look).
  const secrets = ['short-secret', 'abc123', `AIza${'Q'.repeat(35)}`];
  const bodies = [
    `400 {"api_key":"${secrets[0]}"}`,
    `401 Unauthorized authorization: ${secrets[1]}`,
    `400 API key not valid: ${secrets[2]} (https://x/models?key=${secrets[2]})`,
  ];
  for (const body of bodies) {
    const s = await getOperationsHealth(summaryDeps({
      aiProviders: {
        async listProvidersForAdmin() {
          return [{ providerKey: 'gemini', enabled: true, modelChain: [], discoveredModels: [], modelsRefreshedAt: null, modelsRefreshError: body }];
        },
      },
    }));
    const text = JSON.stringify(s.aiModels[0]);
    for (const secret of secrets) assert.equal(text.includes(secret), false, `${secret} must not appear in ${text}`);
    assert.equal(typeof s.aiModels[0].refreshError.kind, 'string');
    assert.ok(REFRESH_ERROR_KINDS.includes(s.aiModels[0].refreshError.kind), `closed vocabulary: ${s.aiModels[0].refreshError.kind}`);
  }
});

test('the kind and status are derived, not copied', () => {
  assert.deepEqual(describeRefreshError('401 Unauthorized: invalid api key'), { status: 401, kind: 'credential' });
  assert.deepEqual(describeRefreshError('No Base URL to list models from'), { status: null, kind: 'not_configured' });
  assert.deepEqual(describeRefreshError('No API key to list models with'), { status: null, kind: 'not_configured' });
  assert.deepEqual(describeRefreshError('429 rate limit exceeded'), { status: 429, kind: 'quota' }, 'the classifier\'s judgement, not ours');
  assert.deepEqual(describeRefreshError('503 Service Unavailable'), { status: 503, kind: 'transient' });
  assert.deepEqual(describeRefreshError('models listing timed out after 15000ms'), { status: null, kind: 'transient' });
  assert.deepEqual(describeRefreshError('404 Not Found'), { status: 404, kind: 'fatal_request' });
  assert.equal(describeRefreshError(null), null);
  for (const k of ['credential', 'not_configured', 'transient', 'fatal_request', 'quota', 'model', 'unknown']) {
    assert.ok(REFRESH_ERROR_KINDS.includes(k));
  }
});

test('a provider is named by its catalogue key only — a free-text provider_key never leaves', async () => {
  // Production held a DISABLED row whose provider_key was a pasted OpenRouter
  // secret. provider_key is operator-typed text; on a public endpoint the only
  // safe name is the catalogue's, and anything else is "custom".
  const pasted = 'sk-or-v1-' + 'f'.repeat(64);
  const s = await getOperationsHealth(summaryDeps({
    aiProviders: {
      async listProvidersForAdmin() {
        return [
          { providerKey: pasted, catalogKey: null, enabled: false, modelChain: [], discoveredModels: [], modelsRefreshedAt: null, modelsRefreshError: null },
          { providerKey: 'gemini', catalogKey: null, enabled: true, modelChain: ['a'], discoveredModels: [], modelsRefreshedAt: null, modelsRefreshError: null },
          { providerKey: 'office-box', catalogKey: 'openrouter', enabled: true, modelChain: ['a'], discoveredModels: [], modelsRefreshedAt: null, modelsRefreshError: null },
          { providerKey: 'my_llm', catalogKey: 'custom', enabled: true, modelChain: [], discoveredModels: [], modelsRefreshedAt: null, modelsRefreshError: null },
        ];
      },
    },
  }));
  const text = JSON.stringify(s);
  assert.equal(text.includes(pasted), false, 'the pasted secret must not appear anywhere');
  assert.equal(text.includes('sk-or'), false);
  assert.equal(text.includes('office-box'), false, 'free text, even harmless, does not leave');
  assert.equal(text.includes('my_llm'), false);
  assert.deepEqual(s.aiModels.map((p) => p.provider), ['custom', 'gemini', 'openrouter', 'custom']);
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
