'use strict';

/**
 * Settings → Dispatcher Board → Board ↔ Bitrix check: the view is counts only
 * (no driver name, no truck), switching on runs a pass at once, and every
 * route is behind the admin gate with "check now" rate-limited.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const admin = require('../services/boardBitrix/admin');
const { createBoardBitrixSettingsRouter } = require('../server/routes/settings/boardBitrixRoutes');
const { createRateLimiter } = require('../server/middleware/rateLimit');

function deps(over = {}) {
  const calls = { enabled: [], sync: [], runs: 0 };
  return {
    calls,
    deps: {
      store: {
        getSettings: async () => ({
          enabled: calls.enabled.at(-1) ?? false,
          syncMode: calls.sync.at(-1)?.syncMode || 'off',
          maxUpdatesPerPass: calls.sync.at(-1)?.maxUpdatesPerPass || 10,
          schemaSource: 'catalog_exact',
          updatedAt: null, updatedBy: null,
        }),
        setEnabled: async (enabled, by) => { calls.enabled.push(enabled); calls.by = by; },
        setSyncSettings: async (settings, by) => { calls.sync.push(settings); calls.syncBy = by; },
        releaseQuestion: async () => { calls.released = (calls.released || 0) + 1; },
        summarise: async () => ({
          open: 5, snoozed: 1, asked: 1, confirmed: 2, seen_fixed: 3,
          byKind: [{ kind: 'fleet_missing', count: 3 }],
          current: { kind: 'truck_differs', askedAt: '2026-10-29T15:00:00Z', details: { board: { name: 'SECRET NAME', truck: '310' } } },
        }),
        ...over.store,
      },
      getRun: async () => ({ lastFinishedAt: 't', lastStatus: 'ok', lastSummary: { boardPeople: 110, activeDeals: 121, activeTrucks: 109, paired: 104, discrepancies: 9 } }),
      runNow: async () => { calls.runs += 1; return { discrepancies: 9 }; },
      ...over.deps,
    },
  };
}

test('the view is counts by kind, the question out by kind and time, the last pass in numbers — never a name', async () => {
  const { deps: d } = deps();
  const view = await admin.getView({ deps: d });
  assert.deepEqual(view.counts, { waiting: 4, skipped: 1, asked: 1, confirmed: 2, fixedWithoutReply: 3 });
  assert.deepEqual(view.byKind, [{ kind: 'fleet_missing', label: 'Driver type not set in Bitrix', count: 3 }]);
  assert.deepEqual(view.current, { kind: 'truck_differs', label: 'Different truck', askedAt: '2026-10-29T15:00:00Z' });
  assert.equal(view.lastRun.differences, 9);
  assert.ok(!JSON.stringify(view).includes('SECRET NAME') && !JSON.stringify(view).includes('310'));
});

test('a schema fallback exposes its catalogue-only reason on the admin view', async () => {
  const { deps: d } = deps({
    store: {
      getSettings: async () => ({
        enabled: true, syncMode: 'off', maxUpdatesPerPass: 10,
        schemaSource: 'static_fallback', schemaCheckedAt: '2026-11-09T20:00:00Z',
        schemaMapping: { problem: 'Bitrix crm.type.list: access denied\nfor this webhook' },
      }),
    },
  });
  const view = await admin.getView({ deps: d });
  assert.equal(view.schema.writeSafe, false);
  assert.equal(view.schema.problem, 'Bitrix crm.type.list: access denied for this webhook');
});

test('switching ON records who and runs a pass at once; OFF runs nothing and puts the question out back in line; a non-boolean is a 400', async () => {
  const { deps: d, calls } = deps();
  await admin.setEnabled(true, { by: 'owner', deps: d });
  assert.deepEqual(calls.enabled, [true]);
  assert.equal(calls.by, 'owner');
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.runs, 1);
  assert.equal(calls.released, undefined);
  await admin.setEnabled(false, { deps: d });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.runs, 1);
  assert.equal(calls.released, 1);
  await assert.rejects(admin.setEnabled('yes', { deps: d }), { statusCode: 400 });
});

test('dry run is easy to enable; live needs the check, a validated schema and explicit confirmation', async () => {
  const { deps: d, calls } = deps();
  await admin.setSyncSettings({ syncMode: 'dry_run', maxUpdatesPerPass: 5 }, { by: 'owner', deps: d });
  assert.deepEqual(calls.sync[0], { syncMode: 'dry_run', maxUpdatesPerPass: 5 });
  assert.equal(calls.syncBy, 'owner');
  await assert.rejects(
    admin.setSyncSettings({ syncMode: 'live', maxUpdatesPerPass: 5 }, { deps: d }),
    /explicit confirmation/
  );
  await assert.rejects(
    admin.setSyncSettings({ syncMode: 'live', maxUpdatesPerPass: 5, confirmLive: true }, { deps: d }),
    /Switch the Board/
  );
  calls.enabled.push(true);
  await admin.setSyncSettings({ syncMode: 'live', maxUpdatesPerPass: 5, confirmLive: true }, { deps: d });
  assert.equal(calls.sync.at(-1).syncMode, 'live');
  await assert.rejects(
    admin.setSyncSettings({ syncMode: 'live', maxUpdatesPerPass: 100, confirmLive: true }, { deps: d }),
    /from 1 to 25/
  );
});

function serve(t, { signedIn = true, runLimiter = null } = {}) {
  const app = express();
  app.use(express.json());
  const authMiddleware = (req, res, next) => {
    if (!signedIn) return res.status(401).json({ error: 'sign in' });
    req.admin = { id: 7, username: 'owner' };
    return next();
  };
  const seen = [];
  const adminService = {
    getView: async () => ({ enabled: true }),
    setEnabled: async (enabled, { by }) => { seen.push({ enabled, by }); if (typeof enabled !== 'boolean') { const e = new Error('enabled must be true or false'); e.statusCode = 400; throw e; } return { enabled }; },
    setSyncSettings: async (body, { by }) => { seen.push({ sync: body.syncMode, by }); return { enabled: true, syncMode: body.syncMode }; },
    runNow: async () => ({ summary: { discrepancies: 2 }, settings: { enabled: true } }),
  };
  app.use('/api/settings', createBoardBitrixSettingsRouter({ authMiddleware, adminService, runLimiter }));
  const server = app.listen(0);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: `http://127.0.0.1:${server.address().port}/api/settings/board-bitrix`, seen };
}

const send = (url, method, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });

test('every route needs a signed-in admin', async (t) => {
  const { base } = serve(t, { signedIn: false });
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await send(`${base}/enabled`, 'PUT', { enabled: true })).status, 401);
  assert.equal((await send(`${base}/sync`, 'PUT', { syncMode: 'dry_run', maxUpdatesPerPass: 10 })).status, 401);
  assert.equal((await send(`${base}/run`, 'POST')).status, 401);
});

test('the switch records who; a bad body is a 400; check now answers the summary and is rate-limited', async (t) => {
  const runLimiter = createRateLimiter({ windowMs: 60_000, max: 1, message: 'slow down' });
  const { base, seen } = serve(t, { runLimiter });
  assert.equal((await send(`${base}/enabled`, 'PUT', { enabled: true })).status, 200);
  assert.deepEqual(seen[0], { enabled: true, by: 'owner' });
  assert.equal((await send(`${base}/enabled`, 'PUT', { enabled: 'yes' })).status, 400);
  assert.equal((await send(`${base}/sync`, 'PUT', { syncMode: 'dry_run', maxUpdatesPerPass: 10 })).status, 200);
  assert.deepEqual(seen[2], { sync: 'dry_run', by: 'owner' });
  const first = await send(`${base}/run`, 'POST');
  assert.equal(first.status, 200);
  assert.equal((await first.json()).summary.discrepancies, 2);
  assert.equal((await send(`${base}/run`, 'POST')).status, 429);
  assert.equal((await fetch(base)).status, 200);
});
