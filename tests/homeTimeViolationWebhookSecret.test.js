'use strict';

/**
 * services/homeTime/violationWebhookSecret.js — the violation webhook's secret
 * is created in the app, stored only encrypted, never sent back to the
 * browser, and the environment variable is only a fallback.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../services/homeTime/violationWebhookSecret');

function memoryStore(initial = null) {
  const store = {
    value: initial,
    reads: 0,
    async getWebhookSecretEncrypted() { store.reads += 1; return store.value; },
    async setWebhookSecretEncrypted(v) { store.value = v; },
  };
  return store;
}

test('a created secret is long and random, stored encrypted, and is what the webhook then expects', async () => {
  S.__resetCacheForTests();
  const store = memoryStore();
  const a = await S.generateWebhookSecret({ store });
  assert.ok(a.length >= 32, 'long');
  assert.match(a, /^[A-Za-z0-9_-]+$/, 'URL-safe');
  assert.ok(store.value && !store.value.includes(a), 'never stored in the clear');
  assert.equal(await S.resolveWebhookSecret({ store, env: {} }), a);

  const b = await S.generateWebhookSecret({ store });
  assert.notEqual(a, b);
  assert.equal(await S.resolveWebhookSecret({ store, env: {} }), b, 'a new link replaces the old at once');
});

test('the app\'s secret wins over the environment; the environment is the fallback; nothing → null', async () => {
  S.__resetCacheForTests();
  assert.equal(await S.resolveWebhookSecret({ store: memoryStore(), env: { HOME_TIME_VIOLATION_WEBHOOK_SECRET: ' env-secret ' } }), 'env-secret');
  S.__resetCacheForTests();
  assert.equal(await S.resolveWebhookSecret({ store: memoryStore(), env: {} }), null);

  S.__resetCacheForTests();
  const store = memoryStore();
  const made = await S.generateWebhookSecret({ store });
  assert.equal(await S.resolveWebhookSecret({ store, env: { HOME_TIME_VIOLATION_WEBHOOK_SECRET: 'env-secret' } }), made);
});

test('a stored value that no longer decrypts is NOT a secret — never a match, never a crash', async () => {
  S.__resetCacheForTests();
  assert.equal(await S.resolveWebhookSecret({ store: memoryStore('garbage.not.valid'), env: {} }), null);
  S.__resetCacheForTests();
  const broken = { async getWebhookSecretEncrypted() { throw new Error('db down'); } };
  assert.equal(await S.resolveWebhookSecret({ store: broken, env: {} }), null);
});

test('read at most once a minute', async () => {
  S.__resetCacheForTests();
  const store = memoryStore();
  await S.resolveWebhookSecret({ store, env: {}, now: 1_000_000 });
  await S.resolveWebhookSecret({ store, env: {}, now: 1_030_000 });
  assert.equal(store.reads, 1);
  await S.resolveWebhookSecret({ store, env: {}, now: 1_061_000 });
  assert.equal(store.reads, 2);
});

test('the browser never sees the stored secret, only whether one is set', () => {
  const row = { id: 1, violation_alerts_enabled: true, violation_webhook_secret_encrypted: 'iv.tag.data' };
  const out = S.publicViolationSettings(row, {});
  assert.equal('violation_webhook_secret_encrypted' in out, false);
  assert.equal(out.violation_webhook_secret_set, true);
  assert.equal(out.violation_alerts_enabled, true);
  assert.equal(S.publicViolationSettings({ id: 1, violation_webhook_secret_encrypted: null }, {}).violation_webhook_secret_set, false);
  assert.equal(S.publicViolationSettings({ id: 1 }, { HOME_TIME_VIOLATION_WEBHOOK_SECRET: 'x' }).violation_webhook_secret_set, true);
  assert.equal(S.publicViolationSettings(null), null);
});
