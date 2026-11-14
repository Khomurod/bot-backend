'use strict';

/**
 * Whether a CDL may be read at all (services/hiringStages/cdlReading.js
 * `cdlReadiness`; owner, 14 November 2026): AI switched off or the task
 * switched off → `off`; no provider chosen — or none of those chosen could be
 * asked (switched off, no key, paid while "Free tiers only" is on, no model
 * that can see) → `no_provider`. The AI settings are stubbed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
function stub(rel, exports) {
  const filename = require.resolve(path.resolve(ROOT, rel));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const world = { settings: { enabled: true, freeOnlyMode: false }, providers: [], enabled: true, order: [] };
stub('services/ai/registry.js', { getRoster: async () => ({ settings: world.settings, providers: world.providers }) });
stub('services/ai/capabilityGate.js', { isCapabilityEnabled: async () => world.enabled, getCapability: async () => null });
stub('services/ai/capabilityProviders.js', { providerOrderFor: async () => world.order });

const { cdlReadiness } = require('../services/hiringStages/cdlReading');

const GEMINI = {
  providerKey: 'gemini', adapter: 'gemini', enabled: true, isFree: true, apiKey: 'k', modelChain: ['gemini-2.5-flash'],
};
const CLAUDE = {
  providerKey: 'anthropic', adapter: 'anthropic', enabled: true, isFree: false, apiKey: 'k', modelChain: ['claude-sonnet-5-5'],
};
const TEXT_ONLY = {
  providerKey: 'cerebras', adapter: 'openai_chat', enabled: true, isFree: true, apiKey: 'k', modelChain: ['qwen-3-32b'],
};

function set(over) {
  Object.assign(world, {
    settings: { enabled: true, freeOnlyMode: false }, providers: [GEMINI, CLAUDE, TEXT_ONLY], enabled: true, order: ['anthropic'],
  }, over);
}

test('ready with a chosen provider that can be asked', async () => {
  set({});
  assert.equal(await cdlReadiness(), 'ready');
});

test('off: AI switched off, or this task switched off', async () => {
  set({ settings: { enabled: false } });
  assert.equal(await cdlReadiness(), 'off');
  set({ enabled: false });
  assert.equal(await cdlReadiness(), 'off');
});

test('no provider: none chosen, or none of those chosen could be asked', async () => {
  for (const over of [
    { order: [] },
    { order: ['openai'] },
    { order: ['anthropic'], settings: { enabled: true, freeOnlyMode: true } },
    { order: ['cerebras'] },
    { order: ['anthropic'], providers: [{ ...CLAUDE, enabled: false }] },
    { order: ['anthropic'], providers: [{ ...CLAUDE, apiKey: '' }] },
  ]) {
    set(over);
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await cdlReadiness(), 'no_provider', JSON.stringify(over.order) + JSON.stringify(over.settings || {}));
  }
  set({ order: ['cerebras', 'gemini'], settings: { enabled: true, freeOnlyMode: true } });
  assert.equal(await cdlReadiness(), 'ready', 'one askable provider is enough');
});
