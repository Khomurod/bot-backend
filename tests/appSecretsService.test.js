'use strict';

/**
 * services/appSecrets/secretsService.js with an in-memory store: no value ever
 * leaves it, unchanged values keep their ciphertext, a save that would stop
 * the app is refused, a stale preview is refused, and nothing is stored
 * without INTEGRATION_SECRET_KEY.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSecretsService } = require('../services/appSecrets/secretsService');
const sharedCrypto = require('../lib/security/sharedIntegrationCrypto');

const KEY = { INTEGRATION_SECRET_KEY: 'service-test-key-0123456789abcdef' };
const T1 = '111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const T2 = '222222:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2';
const T3 = '333333:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3';
const HOST = { JWT_SECRET: 'jwt-host-value', FACEBOOK_TOKEN_ENCRYPTION_KEY: 'fb-host-value' };

function memoryStore() {
  const versions = [];
  const values = new Map();
  return {
    versions,
    values,
    async getLatestVersion() { return versions[versions.length - 1] || null; },
    async getVersion(id) { return versions.find((v) => v.id === Number(id)) || null; },
    async getVersionValues(id) { return values.get(Number(id)) || []; },
    async listVersions() {
      return [...versions].reverse().map((v) => ({ ...v, value_count: (values.get(v.id) || []).length }));
    },
    async insertVersion({ createdBy, note, keyFingerprint, restoredFrom, values: rows, expectedHead }) {
      if (Number(expectedHead || 0) !== versions.length) {
        throw Object.assign(new Error('stale'), { code: 'STALE_HEAD' });
      }
      const id = versions.length + 1;
      versions.push({ id, created_at: new Date(0), created_by: createdBy, note, key_fingerprint: keyFingerprint, restored_from: restoredFrom });
      values.set(id, rows.map((r) => ({ ...r })));
      return id;
    },
  };
}

function service({ store = memoryStore(), key = KEY, host = HOST, tokens = {} } = {}) {
  const svc = createSecretsService({
    store,
    keyEnv: () => key,
    hostEnv: () => host,
    bootState: () => ({ status: 'loaded', version: 1, names: [], overridden: [] }),
    checkTelegramToken: async (t) => tokens[t] || { ok: true, username: '@bot' },
  });
  return { svc, store };
}

const BOT_FILE = `BOT_TOKEN=${T1}\nTELEGRAM_BOT_TOKEN=${T2}\nGROQ_API_KEY=gsk_live_value_0000\nDATABASE_URL=postgres://nope\n`;

test('a preview names what changes and carries no value at all', async () => {
  const { svc } = service();
  const p = await svc.preview({ target: 'bot', text: BOT_FILE });
  assert.deepEqual(p.added.map((c) => `${c.scope}:${c.name}`), ['both:BOT_TOKEN', 'both:GROQ_API_KEY', 'bot:TELEGRAM_BOT_TOKEN']);
  assert.deepEqual(p.skipped.map((s) => s.name), ['DATABASE_URL']);
  assert.equal(p.canSave, true);
  assert.equal(p.restartsThisApp, true);
  const json = JSON.stringify(p);
  for (const secret of [T1, T2, 'gsk_live_value_0000', 'postgres://nope']) assert.ok(!json.includes(secret), secret);
});

test('save writes an encrypted version; a second save keeps unchanged ciphertexts', async () => {
  const { svc, store } = service();
  const first = await svc.save({ target: 'bot', text: BOT_FILE, baseVersion: null, by: 'owner' });
  assert.equal(first.versionId, 1);
  const rows1 = store.values.get(1);
  assert.equal(rows1.length, 3);
  for (const r of rows1) assert.ok(!r.ciphertext.includes(T1) && !r.ciphertext.includes(T2));
  assert.equal(sharedCrypto.decryptShared(rows1.find((r) => r.name === 'BOT_TOKEN').ciphertext, KEY), T1);
  assert.equal(rows1.find((r) => r.name === 'BOT_TOKEN').last4, T1.slice(-4));
  assert.equal(store.versions[0].key_fingerprint, sharedCrypto.fingerprint(KEY));

  const second = await svc.save({ target: 'samsara', text: `SAMSARA_BOT_TOKEN=${T3}\nHARDCODED_GROUP_ID=-1001\n`, baseVersion: 1 });
  assert.equal(second.versionId, 2);
  assert.equal(second.preview.restartsThisApp, false, 'only the Samsara service\'s values changed');
  const before = new Map(rows1.map((r) => [`${r.scope}:${r.name}`, r.ciphertext]));
  for (const r of store.values.get(2)) {
    if (before.has(`${r.scope}:${r.name}`)) assert.equal(r.ciphertext, before.get(`${r.scope}:${r.name}`));
  }
  assert.equal(store.values.get(2).length, 5);
});

test('a preview older than the stored version is refused', async () => {
  const { svc } = service();
  await svc.save({ target: 'bot', text: BOT_FILE, baseVersion: null });
  await assert.rejects(svc.save({ target: 'bot', text: BOT_FILE, baseVersion: null }), (e) => e.statusCode === 409);
});

test('a save this app could not start with is refused, with the reason and no value', async () => {
  const { svc, store } = service({ host: {} });
  await assert.rejects(
    svc.save({ target: 'bot', text: BOT_FILE, baseVersion: null }),
    (e) => e.statusCode === 400 && /JWT_SECRET is missing/.test(e.message) && !e.message.includes(T1),
  );
  assert.equal(store.versions.length, 0);
});

test('two bots on one token, or a token Telegram refuses, block the save', async () => {
  const same = service();
  const p = await same.svc.preview({ target: 'bot', text: `BOT_TOKEN=${T1}\nTELEGRAM_BOT_TOKEN=${T1}\n` });
  assert.equal(p.canSave, false);
  assert.match(p.blocking.join(' '), /same token/);

  const refused = service({ tokens: { [T2]: { ok: false, error: 'Telegram does not know this token' } } });
  const q = await refused.svc.preview({ target: 'bot', text: BOT_FILE });
  assert.equal(q.canSave, false);
  assert.match(q.blocking.join(' '), /TELEGRAM_BOT_TOKEN: Telegram refused/);
  assert.deepEqual(q.tokens.map((t) => [t.name, t.ok]), [['BOT_TOKEN', true], ['TELEGRAM_BOT_TOKEN', false]]);
});

test('nothing is stored without INTEGRATION_SECRET_KEY', async () => {
  const { svc } = service({ key: null });
  await assert.rejects(svc.preview({ target: 'bot', text: BOT_FILE }), (e) => e.statusCode === 409);
  const view = await svc.getView();
  assert.equal(view.keyConfigured, false);
});

test('a version under another key is not opened, and the view says so', async () => {
  const { svc, store } = service();
  await svc.save({ target: 'bot', text: BOT_FILE, baseVersion: null });
  const other = service({ store, key: { INTEGRATION_SECRET_KEY: 'a-different-key-0000000000000' } });
  await assert.rejects(other.svc.preview({ target: 'bot', text: BOT_FILE }), (e) => e.statusCode === 409);
  const view = await other.svc.getView();
  assert.equal(view.latest.sameKey, false);
});

test('the view lists names, scopes and last four characters — no value', async () => {
  const { svc } = service();
  await svc.save({ target: 'bot', text: `${BOT_FILE}SHORT=abc\n`, baseVersion: null });
  const view = await svc.getView();
  const json = JSON.stringify(view);
  for (const secret of [T1, T2, 'gsk_live_value_0000']) assert.ok(!json.includes(secret));
  assert.deepEqual(view.values.find((v) => v.name === 'SHORT'), { scope: 'bot', name: 'SHORT', last4: '', inUseHere: true });
  assert.equal(view.versions.length, 1);
});

test('remove and restore write new versions; restore keeps the old ciphertexts', async () => {
  const { svc, store } = service();
  await svc.save({ target: 'bot', text: `${BOT_FILE}EXTRA=value-to-remove\n`, baseVersion: null });
  const removed = await svc.removeValue({ scope: 'bot', name: 'EXTRA' });
  assert.equal(removed.versionId, 2);
  assert.ok(!store.values.get(2).some((r) => r.name === 'EXTRA'));
  await assert.rejects(svc.removeValue({ scope: 'bot', name: 'EXTRA' }), (e) => e.statusCode === 400);

  const restored = await svc.restore({ versionId: 1 });
  assert.deepEqual(restored, { versionId: 3, restoredFrom: 1 });
  assert.deepEqual(store.values.get(3), store.values.get(1));
  assert.equal(store.versions[2].restored_from, 1);
});

test('removing a value this app needs is refused', async () => {
  const { svc } = service({ host: { FACEBOOK_TOKEN_ENCRYPTION_KEY: 'f' } });
  await svc.save({ target: 'bot', text: `${BOT_FILE}JWT_SECRET=jwt-secret-value-long\n`, baseVersion: null });
  await assert.rejects(svc.removeValue({ scope: 'bot', name: 'JWT_SECRET' }), /JWT_SECRET is missing/);
});

test('a removal or restore read before somebody else\'s save is refused, not written over it', async () => {
  const { svc, store } = service();
  await svc.save({ target: 'bot', text: `${BOT_FILE}EXTRA=extra-value-long-1\n`, baseVersion: null });
  await svc.save({ target: 'bot', text: `${BOT_FILE}EXTRA=extra-value-long-2\n`, baseVersion: 1 });
  // Both read their snapshot when version 1 was still the newest.
  const realLatest = store.getLatestVersion;
  store.getLatestVersion = async () => store.versions[0];
  await assert.rejects(svc.removeValue({ scope: 'bot', name: 'EXTRA' }), (e) => e.statusCode === 409);
  await assert.rejects(svc.restore({ versionId: 1 }), (e) => e.statusCode === 409);
  store.getLatestVersion = realLatest;
  assert.equal(store.versions.length, 2, 'nothing was written over version 2');
});
