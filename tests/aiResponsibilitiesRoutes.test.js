/**
 * GET /ai/responsibilities and PUT /ai/capabilities/:key — the two endpoints
 * behind the screen that claims to say what Wenze may decide.
 *
 * Both promises here are about being HONEST rather than convenient. A screen
 * presented as the authoritative control must not report "automatic changes
 * off" when it simply could not read the setting, and a switch must not report
 * success before the value is stored — a 30-second cache reloaded in that
 * window would show the capability off while the calls kept going.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const ROUTE = path.resolve(__dirname, '../server/routes/settings/aiRoutes.js');
const SETTINGS = path.resolve(__dirname, '../database/aiSettings.js');
const CHECK_SETTINGS = path.resolve(__dirname, '../database/operationalCheckSettings.js');
const GATE = path.resolve(__dirname, '../services/ai/capabilityGate.js');
const REGISTRY = path.resolve(__dirname, '../services/ai/registry.js');

function loadApp({
  capabilities = [], checks = [], checksThrow = null, updateCapability = null,
} = {}) {
  delete require.cache[require.resolve(ROUTE)];
  const saw = { invalidatedAt: [], updatedAt: [] };

  require.cache[SETTINGS] = {
    exports: {
      async getAiSettings() { return { enabled: true }; },
      async updateAiSettings(p) { return p; },
      async listCapabilities() { return capabilities; },
      async updateCapability(key, patch) {
        saw.updatedAt.push(Date.now());
        if (updateCapability) return updateCapability(key, patch);
        return { capabilityKey: key, ...patch };
      },
      invalidateCache() {},
      DEFAULTS: {},
    },
  };
  require.cache[CHECK_SETTINGS] = {
    exports: {
      async listCheckSettings() {
        if (checksThrow) throw new Error(checksThrow);
        return checks;
      },
    },
  };
  require.cache[GATE] = {
    exports: {
      invalidateCapabilityCache() { saw.invalidatedAt.push(Date.now()); },
      async isCapabilityEnabled() { return true; },
    },
  };
  require.cache[REGISTRY] = { exports: { invalidateRegistry() {}, getRoster: async () => ({}) } };
  for (const m of ['aiProviders', 'aiCallLog', 'aiModelEvents']) {
    require.cache[path.resolve(__dirname, `../database/${m}.js`)] = {
      exports: {
        async listProvidersForAdmin() { return []; },
        async getProvidersForRouter() { return []; },
        async upsertProvider() { return {}; },
        async deleteProvider() { return true; },
        async clearCooldown() { return {}; },
        async summariseProviderHealth() { return []; },
        async listRecentFailures() { return []; },
        async listModelEvents() { return []; },
        async recordModelEvent() {},
      },
    };
  }

  const { createAiSettingsRouter } = require(ROUTE);
  const app = express();
  app.use(express.json());
  app.use('/api/settings', createAiSettingsRouter({
    authMiddleware: (req, _res, next) => { req.admin = { username: 'admin' }; next(); },
  }));
  return { app, saw };
}

async function call(app, method, url, body) {
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally { server.close(); }
}

function findCapability(groups, key) {
  for (const g of groups) {
    const hit = g.capabilities.find((c) => c.key === key);
    if (hit) return hit;
  }
  return null;
}

test('a state-changing responsibility reports its automation setting', async () => {
  const { app } = loadApp({
    checks: [{ checkKey: 'home_time.returned_to_road', autoApplyEnabled: true, maxAutoPerRun: 25 }],
  });
  const res = await call(app, 'GET', '/api/settings/ai/responsibilities');
  assert.equal(res.status, 200);
  const cap = findCapability(res.body.groups, 'home_time_return_to_road');
  assert.deepEqual(cap.automation, {
    checkKey: 'home_time.returned_to_road', enabled: true, maxPerRun: 25, known: true,
  });
});

test('a setting that could not be READ is unknown, never reported as off', async () => {
  // The dangerous version of this bug is silent: the screen says "automatic
  // changes: off" while corrections keep being applied, and an operator who
  // trusts the screen never looks again.
  const { app } = loadApp({ checksThrow: 'connection refused' });
  const res = await call(app, 'GET', '/api/settings/ai/responsibilities');
  assert.equal(res.status, 200, 'the responsibilities themselves still render');
  const cap = findCapability(res.body.groups, 'home_time_return_to_road');
  assert.equal(cap.automation.known, false,
    'the screen must say it does not know, rather than show the reassuring answer');
  assert.equal(cap.automation.enabled, null, 'and must not invent a value');
  assert.match(res.body.automationError, /connection refused/);
});

test('a check with no stored row is known and off — that IS the stored answer', async () => {
  const { app } = loadApp({ checks: [] });
  const res = await call(app, 'GET', '/api/settings/ai/responsibilities');
  const cap = findCapability(res.body.groups, 'home_time_return_to_road');
  assert.equal(cap.automation.known, true, 'the list was read; this check is simply absent from it');
  assert.equal(cap.automation.enabled, false, 'and default-deny is what absent means');
});

test('the cache is cleared AFTER the value is stored, never before', async () => {
  const { app, saw } = loadApp({
    updateCapability: async (key, patch) => {
      await new Promise((r) => setTimeout(r, 25)); // the commit takes time
      return { capabilityKey: key, ...patch };
    },
  });
  const res = await call(app, 'PUT', '/api/settings/ai/capabilities/home_time_intent', { aiEnabled: false });
  assert.equal(res.status, 200);
  assert.equal(saw.updatedAt.length, 1);
  assert.equal(saw.invalidatedAt.length, 1);
  assert.ok(saw.invalidatedAt[0] >= saw.updatedAt[0],
    'invalidating first lets a concurrent call reload the OLD value and cache it for another 30s');
});

test('a failed save does not clear the cache, because nothing changed', async () => {
  const { app, saw } = loadApp({
    updateCapability: async () => { throw new Error('write failed'); },
  });
  const res = await call(app, 'PUT', '/api/settings/ai/capabilities/home_time_intent', { aiEnabled: false });
  assert.equal(res.status >= 400, true);
  assert.equal(saw.invalidatedAt.length, 0);
});

test('an unknown capability is a 404 and clears nothing', async () => {
  const { app, saw } = loadApp({ updateCapability: async () => null });
  const res = await call(app, 'PUT', '/api/settings/ai/capabilities/nope', { aiEnabled: false });
  assert.equal(res.status, 404);
  assert.equal(saw.invalidatedAt.length, 0);
});
