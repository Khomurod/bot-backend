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
    fuelReadings: {
      async summariseFuelReadings() {
        return { trucks: 110, withFuel: 104, comparable: 61, newestReading: '2026-09-20T17:40:00.000Z' };
      },
    },
    // The safety block is composed in, so it is faked in.
    safety: {
      async summariseSafety() {
        return {
          windowDays: 14, events: 9, byBehavior: { harsh_braking: 6, speeding: 3 },
          driversWithEvents: 2, coachingSent: 1, coachingToDrivers: 1,
        };
      },
    },
    // Each block below is composed into the same summary, so each is faked in.
    // (This harness has now grown a dep four times for exactly that reason;
    // a missing one shows up as "cannot read properties of undefined".)
    systemHealth: {
      async summariseHealthStates() {
        return { ok: 2, failed: 1, unchecked: 0, flapping: 0, down: ['ai_providers'] };
      },
    },
    learning: {
      async summariseSuggestions() { return { proposed: 1, accepted: 0, dismissed: 2 }; },
    },
    retention: {
      async summariseRetention() { return { urgent: 1, watch: 3, acknowledged: 1, lastPassAt: null }; },
    },
    learningPass: {
      getLearningStatus: () => ({
        running: true,
        lastRun: { at: '2026-09-11T04:40:00.000Z', ok: true, found: 0, proposed: 0, announced: 0, errors: 0 },
      }),
    },
    retentionWatch: {
      getRetentionStatus: () => ({
        running: true,
        lastRun: { at: '2026-09-11T04:40:00.000Z', ok: true, checked: 108, flagged: 2, notified: 1, urgent: 1, errors: 0 },
      }),
    },
    notificationSettings: {
      async getNotificationSettings() {
        return { enabled: true, defaultChatId: '-1005052301861', categoryChatIds: { fuel: '-100999' } };
      },
    },
    // The load lifecycle block is composed in, so it is faked in.
    loads: {
      async summariseLoadPhases() {
        return { total: 12, byPhase: { in_transit: 7, at_pickup: 3, delivered: 2 }, unclear: 2, conflicted: 1 };
      },
    },
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
  assert.equal(s.loads.total, 12);
  assert.equal(s.loads.conflicted, 1, 'a load the board and the truck disagree about is visible live');
  assert.equal(s.safety.events, 9);
  assert.equal(s.safety.coachingToDrivers, 1, 'how much coaching actually reached a driver');
  assert.equal(s.fuel.comparable, 61,
    'how many trucks Smart Fuel can actually compare — zero here would mean the '
    + 'abnormal-consumption engine is blind, which is what it silently was');
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

/**
 * Whether Wenze can be heard at all.
 *
 * With no destination configured, `notify()` discards every notice at the door
 * — deliberately, so a group set months later cannot deliver a backlog of stale
 * alerts. The cost is that every feature that speaks would run, work, and say
 * nothing. That is the exact failure this whole project started from, so it
 * belongs on the health check and on the Needs Attention page, not in a console
 * line nobody reads.
 */
test('the health block says whether anybody is receiving notices — without saying where', async () => {
  const health = await getOperationsHealth(summaryDeps());

  assert.equal(health.notifications.reachable, true);
  assert.equal(health.notifications.defaultConfigured, true);
  assert.equal(health.notifications.categoryOverrides, 1);

  // A group id is enough to attempt a join, and this endpoint is read by an
  // uptime monitor. The answer is a boolean, never a destination.
  const serialised = JSON.stringify(health.notifications);
  assert.ok(!serialised.includes('5052301861'), 'no chat id leaves the health endpoint');
  assert.ok(!serialised.includes('100999'));
});

test('an unconfigured destination reads as NOT reachable', async () => {
  const health = await getOperationsHealth(summaryDeps({
    notificationSettings: {
      async getNotificationSettings() {
        return { enabled: true, defaultChatId: null, categoryChatIds: {} };
      },
    },
  }));
  assert.equal(health.notifications.reachable, false);
  assert.equal(health.notifications.defaultConfigured, false);
});

test('notifications switched off reads as not reachable, however it is configured', async () => {
  const health = await getOperationsHealth(summaryDeps({
    notificationSettings: {
      async getNotificationSettings() {
        return { enabled: false, defaultChatId: '-100111', categoryChatIds: {} };
      },
    },
  }));
  assert.equal(health.notifications.reachable, false);
});

test('a missing settings table is "not available", not "not reachable"', async () => {
  // A deploy in progress. Reporting it as unreachable would page somebody about
  // a migration that is thirty seconds from finishing.
  const health = await getOperationsHealth(summaryDeps({
    notificationSettings: { async getNotificationSettings() { throw new Error('no such table'); } },
  }));
  assert.deepEqual(health.notifications, { available: false });
});

/**
 * "Ran and found nobody" and "never ran" are the same empty table.
 *
 * A background job whose failure looks identical to its success is the shape of
 * problem this whole phase exists to remove — the outbox retried, gave up, and
 * told nobody — so shipping another one would be a poor joke.
 */
test('the retention block says whether the pass has actually RUN, not only what it found', async () => {
  const health = await getOperationsHealth(summaryDeps());
  assert.equal(health.retention.watch.running, true);
  assert.equal(health.retention.watch.lastRun.ok, true);
  assert.equal(health.retention.watch.lastRun.checked, 108,
    'how many drivers it looked at — zero flagged out of 108 is a result, zero out of zero is not');
  assert.equal(health.retention.urgent, 1, 'and the counts are still there');
});

test('a pass that has never run is distinguishable from one that found nobody', async () => {
  const neverRan = await getOperationsHealth(summaryDeps({
    learningPass: {
      getLearningStatus: () => ({
        running: true,
        lastRun: { at: '2026-09-11T04:40:00.000Z', ok: true, found: 0, proposed: 0, announced: 0, errors: 0 },
      }),
    },
    retentionWatch: { getRetentionStatus: () => ({ running: true, lastRun: null }) },
  }));
  assert.equal(neverRan.retention.watch.lastRun, null);

  const ranAndFoundNobody = await getOperationsHealth(summaryDeps({
    retention: { async summariseRetention() { return { urgent: 0, watch: 0, acknowledged: 0, lastPassAt: null }; } },
    learningPass: {
      getLearningStatus: () => ({
        running: true,
        lastRun: { at: '2026-09-11T04:40:00.000Z', ok: true, found: 0, proposed: 0, announced: 0, errors: 0 },
      }),
    },
    retentionWatch: {
      getRetentionStatus: () => ({ running: true, lastRun: { at: 'now', ok: true, checked: 108, flagged: 0 } }),
    },
  }));
  assert.equal(ranAndFoundNobody.retention.watch.lastRun.checked, 108);
  assert.equal(ranAndFoundNobody.retention.urgent, 0);
});

test('a pass that CRASHED says so, with the reason', async () => {
  const crashed = await getOperationsHealth(summaryDeps({
    learningPass: {
      getLearningStatus: () => ({
        running: true,
        lastRun: { at: '2026-09-11T04:40:00.000Z', ok: true, found: 0, proposed: 0, announced: 0, errors: 0 },
      }),
    },
    retentionWatch: {
      getRetentionStatus: () => ({
        running: true,
        lastRun: { at: '2026-09-11T04:40:00.000Z', ok: false, error: 'relation does not exist' },
      }),
    },
  }));
  assert.equal(crashed.retention.watch.lastRun.ok, false);
  assert.match(crashed.retention.watch.lastRun.error, /relation does not exist/);
});

test('the learning block says whether it has LOOKED — finding nothing writes no row', async () => {
  const health = await getOperationsHealth(summaryDeps());
  assert.equal(health.learning.pass.lastRun.ok, true);
  assert.equal(health.learning.pass.lastRun.found, 0, 'looked, and there was nothing to propose');
  assert.equal(health.learning.proposed, 1, 'and the counts are still there');

  const neverLooked = await getOperationsHealth(summaryDeps({
    learningPass: { getLearningStatus: () => ({ running: true, lastRun: null }) },
  }));
  assert.equal(neverLooked.learning.pass.lastRun, null, 'which is a different answer');
});
