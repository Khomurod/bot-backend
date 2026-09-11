/**
 * The Home Time health block: the only way to check, from outside a running
 * Render instance with no database session, that the feature is doing its job.
 *
 * Two properties matter more than the numbers themselves. It must never make
 * /api/health unhealthy — Render restarts on that — and it must never carry a
 * driver name, a chat id or a notice body, because the endpoint is public and
 * unauthenticated.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { getHomeTimeHealth, summariseCapabilities } = require('../services/operations/homeTimeHealth');

const LIVE = {
  observability: {
    async summariseReturnWatch() {
      return {
        watching: 4, anchored: 3, high: 1, medium: 1, low: 2,
        lastCheckedAt: '2026-09-20T18:00:00Z', oldestCheckedAt: '2026-09-20T17:48:00Z',
      };
    },
    async summariseManagerNotices() {
      return { arrived_home: { rows: 6, events: 6, delivered: 6, pending: 0, failed: 0, abandoned: 0 } };
    },
    async summariseRequestStatuses() { return { recorded: 12, pending: 79, expired: 117 }; },
    async summariseReturnCorrections() {
      return { applied: 5, reverted: 1, lastAppliedAt: '2026-09-20T17:30:00Z' };
    },
  },
  aiSettings: {
    async listCapabilities() {
      return [
        { capabilityKey: 'a', aiEnabled: true, mayAutoApply: false },
        { capabilityKey: 'b', aiEnabled: false, mayAutoApply: false },
      ];
    },
  },
};

test('the block reports what the watcher and the notices are actually doing', async () => {
  const health = await getHomeTimeHealth(LIVE);
  assert.equal(health.available, true);
  assert.equal(health.returnWatch.watching, 4);
  assert.equal(health.returnWatch.high, 1);
  assert.equal(health.automaticReturns.applied, 5);
  assert.equal(health.automaticReturns.reverted, 1);
  assert.equal(health.aiResponsibilities.registered, 2);
  assert.equal(health.aiResponsibilities.switchedOff, 1);
});

test('rows and distinct events are reported separately, so a duplicate would SHOW', async () => {
  const health = await getHomeTimeHealth(LIVE);
  const arrived = health.managerNotices.arrived_home;
  assert.equal(arrived.rows, arrived.events,
    'event_key is UNIQUE, so these are equal by construction — a difference is a broken constraint');
});

test('`recorded` and the frozen historical `pending` are both visible', async () => {
  const health = await getHomeTimeHealth(LIVE);
  assert.equal(health.requestsByStatus.recorded, 12, 'the new terminal status is rising');
  assert.equal(health.requestsByStatus.pending, 79, 'and the old rows were preserved, not rewritten');
});

test('a capability that could auto-apply would be counted, because the schema forbids it', async () => {
  const health = await getHomeTimeHealth(LIVE);
  assert.equal(health.aiResponsibilities.mayAutoApply, 0);
});

test('nothing in the block can identify a driver, a chat or a notice', async () => {
  const health = await getHomeTimeHealth(LIVE);
  const json = JSON.stringify(health);
  // Every leaf must be a number, a null, or an ISO timestamp. A name, a chat id
  // or a notice body could not survive that rule.
  const walk = (node, path) => {
    if (node === null || typeof node === 'number' || typeof node === 'boolean') return;
    if (typeof node === 'string') {
      assert.match(node, /^\d{4}-\d{2}-\d{2}T/, `${path} is free text on a public endpoint: ${node}`);
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
  };
  walk(health, 'homeTime');
  assert.ok(!/chat|driver|telegram|body/i.test(json), 'no key hints at an identifier');
});

test('a database that is not ready reads as unavailable, never as unhealthy', async () => {
  const health = await getHomeTimeHealth({
    observability: {
      async summariseReturnWatch() { throw new Error('relation "home_time_return_watch" does not exist'); },
      async summariseManagerNotices() { return {}; },
      async summariseRequestStatuses() { return {}; },
      async summariseReturnCorrections() { return {}; },
    },
    aiSettings: { async listCapabilities() { return []; } },
  });
  assert.equal(health.available, false);
  assert.match(health.error, /home_time_return_watch/);
});

test('the AI capability summary survives a table that is not there yet', async () => {
  const health = await getHomeTimeHealth({
    observability: LIVE.observability,
    aiSettings: { async listCapabilities() { throw new Error('no such table'); } },
  });
  assert.equal(health.available, true, 'the rest of the block still reports');
  assert.equal(health.aiResponsibilities, null);
});

test('summariseCapabilities counts an unregistered roster as empty, not as an error', async () => {
  const out = await summariseCapabilities({ aiSettings: { async listCapabilities() { return null; } } });
  assert.deepEqual(out, { registered: 0, switchedOff: 0, mayAutoApply: 0 });
});
