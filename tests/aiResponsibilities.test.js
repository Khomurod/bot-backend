/**
 * What AI is allowed to do, and whether saying "no" actually stops it.
 *
 * Two things were true before this and are the reason the suite exists:
 * `ai_capabilities` was empty in production, so the admin's per-feature table
 * rendered nothing; and no code path read the flag, so an operator switching a
 * capability off changed nothing at all. A switch that does not switch anything
 * is worse than no switch, because it is believed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const catalog = require('../lib/ai/capabilityCatalog');
const { registerKnownCapabilities } = require('../services/ai/capabilityRegistry');

const GATE_PATH = path.resolve(__dirname, '../services/ai/capabilityGate.js');
const SETTINGS_PATH = path.resolve(__dirname, '../database/aiSettings.js');

// ── the catalogue ────────────────────────────────────────────────────────────

test('every responsibility is described in words a non-technical person can act on', () => {
  for (const cap of catalog.CAPABILITIES) {
    assert.match(cap.key, /^[a-z][a-z0-9_]*$/, `${cap.key} is a stable key`);
    assert.ok(cap.label && cap.label.length > 3, `${cap.key} has a label`);
    assert.ok(cap.what && cap.what.length > 20, `${cap.key} says what it decides`);
    assert.ok(cap.group, `${cap.key} belongs to a section`);
    assert.ok(cap.fallback && cap.fallback.length > 10,
      `${cap.key} says what happens with AI off — an operator cannot judge a switch without it`);
    assert.equal(typeof cap.changesState, 'boolean');
    // The label is what a manager reads; it must not be the key with underscores.
    assert.equal(cap.label.includes('_'), false, `${cap.key} label reads as English`);
  }
});

test('anything that can change stored information says so, and says what it changes', () => {
  for (const cap of catalog.CAPABILITIES.filter((c) => c.changesState)) {
    assert.ok(cap.stateNote && cap.stateNote.length > 15,
      `${cap.key} must say what it writes`);
  }
  // And the ones that only produce words must not claim otherwise.
  for (const cap of catalog.CAPABILITIES.filter((c) => !c.changesState)) {
    assert.equal(cap.stateNote, undefined, `${cap.key} writes nothing, so it explains nothing`);
  }
});

test('a capability that can change state automatically names the switch that governs it', () => {
  const automated = catalog.CAPABILITIES.filter((c) => c.automationCheck);
  assert.ok(automated.length >= 1);
  for (const cap of automated) {
    assert.match(cap.automationCheck, /^[a-z_]+\.[a-z_]+$/, 'an operational check key');
    assert.ok(cap.mediumNote, `${cap.key} says what happens short of confident`);
  }
});

test('the keys are unique and the grouping keeps every one of them', () => {
  const keys = catalog.CAPABILITIES.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate keys');
  const grouped = catalog.groupedCapabilities().flatMap((g) => g.capabilities.map((c) => c.key));
  assert.deepEqual(grouped.slice().sort(), keys.slice().sort());
});

test('every capability the code actually asks for is in the catalogue', () => {
  // A call site tagged with a key that has no entry would log activity nobody
  // can find a switch for.
  const roots = ['services', 'server', 'lib'];
  const used = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const src = fs.readFileSync(full, 'utf8');
      for (const m of src.matchAll(/capability:\s*'([a-z0-9_]+)'/g)) used.add(m[1]);
      for (const m of src.matchAll(/^const CAPABILITY = '([a-z0-9_]+)'/gm)) used.add(m[1]);
    }
  };
  for (const root of roots) walk(path.resolve(__dirname, '..', root));
  assert.ok(used.size >= 10, `expected many tagged call sites, found ${used.size}`);
  for (const key of used) {
    assert.ok(catalog.getCapabilityMeta(key), `"${key}" is tagged in code but missing from the catalogue`);
  }
});

// ── the gate ─────────────────────────────────────────────────────────────────

function loadGate(rows, { throws = false } = {}) {
  delete require.cache[GATE_PATH];
  delete require.cache[SETTINGS_PATH];
  require.cache[SETTINGS_PATH] = {
    exports: {
      async listCapabilities() {
        if (throws) throw new Error('database unavailable');
        return rows;
      },
    },
  };
  return require(GATE_PATH);
}

test('a capability nobody has switched off is enabled', async () => {
  const gate = loadGate([{ capabilityKey: 'home_time_intent', aiEnabled: true }]);
  assert.equal(await gate.isCapabilityEnabled('home_time_intent'), true);
});

test('a capability with no row at all is enabled — a new one is never silently off', async () => {
  const gate = loadGate([]);
  assert.equal(await gate.isCapabilityEnabled('brand_new_thing'), true);
});

test('switching one off is honoured', async () => {
  const gate = loadGate([{ capabilityKey: 'driver_status_classification', aiEnabled: false }]);
  assert.equal(await gate.isCapabilityEnabled('driver_status_classification'), false);
  assert.equal(await gate.isCapabilityEnabled('home_time_intent'), true, 'and only that one');
});

test('a database problem leaves AI on rather than becoming a new way for it to fail', async () => {
  const gate = loadGate([], { throws: true });
  assert.equal(await gate.isCapabilityEnabled('home_time_intent'), true);
});

// ── registering the catalogue ────────────────────────────────────────────────

test('registration writes every catalogue entry and never touches the operator switch', async () => {
  const calls = [];
  const summary = await registerKnownCapabilities({
    aiSettings: {
      async registerCapability(key, payload) { calls.push({ key, payload }); return { key }; },
    },
    invalidateCapabilityCache() {},
  });
  assert.equal(summary.registered, catalog.CAPABILITIES.length);
  assert.equal(summary.failed, 0);
  for (const call of calls) {
    assert.ok(call.payload.label);
    assert.equal(typeof call.payload.sendsRawText, 'boolean');
    assert.equal('aiEnabled' in call.payload, false,
      'registration must never write ai_enabled — that column belongs to the operator');
  }
});

test('a failing registration is reported, not thrown — it must never stop a boot', async () => {
  const summary = await registerKnownCapabilities({
    aiSettings: { async registerCapability() { throw new Error('no database yet'); } },
    invalidateCapabilityCache() { throw new Error('also broken'); },
  });
  assert.equal(summary.registered, 0);
  assert.equal(summary.failed, catalog.CAPABILITIES.length);
});
