'use strict';

/**
 * The boot read of the app secrets (config/appSecretsBoot.js and
 * config/appSecretsFetch.js): stored values override Coolify, anything that
 * goes wrong leaves Coolify's environment as it was, the switches in Coolify
 * work, only INTEGRATION_SECRET_KEY opens a value, and no value is logged.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { loadAppSecrets, getBootState, getHostEnv } = require('../config/appSecretsBoot');
const { fetchAppSecrets } = require('../config/appSecretsFetch');
const sharedCrypto = require('../lib/security/sharedIntegrationCrypto');

function recorder() {
  const lines = [];
  const log = { log: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
  return { lines, log };
}

test('stored values override Coolify; the log names what, never a value', () => {
  const env = { BOT_TOKEN: 'coolify-token-0000', KEEP: 'k' };
  const { lines, log } = recorder();
  const fetch = () => ({ status: 'loaded', version: 4, values: { BOT_TOKEN: 'stored-token-1111', NEW_ONE: 'secret-new-2222' } });
  const state = loadAppSecrets('bot', { env, fetch, log });
  assert.equal(env.BOT_TOKEN, 'stored-token-1111');
  assert.equal(env.NEW_ONE, 'secret-new-2222');
  assert.equal(env.KEEP, 'k');
  assert.equal(state.status, 'loaded');
  assert.deepEqual(getBootState().overridden, ['BOT_TOKEN']);
  assert.equal(getHostEnv().BOT_TOKEN, 'coolify-token-0000', 'what Coolify had is kept for the save checks');
  assert.match(lines.join('\n'), /version 4/);
  assert.ok(!/stored-token|secret-new|coolify-token/.test(lines.join('\n')));
});

test('a failed or skipped read leaves the environment exactly as it was', () => {
  for (const result of [
    { status: 'failed', reason: 'database read failed' },
    { status: 'skipped', reason: 'nothing is stored yet' },
    null,
  ]) {
    const env = { BOT_TOKEN: 'coolify' };
    const { log } = recorder();
    const state = loadAppSecrets('bot', { env, fetch: () => result, log });
    assert.deepEqual(env, { BOT_TOKEN: 'coolify' });
    assert.notEqual(state.status, 'loaded');
  }
  const env = { BOT_TOKEN: 'coolify' };
  const state = loadAppSecrets('bot', { env, fetch: () => { throw new Error('boom'); }, log: recorder().log });
  assert.equal(state.status, 'failed');
  assert.deepEqual(env, { BOT_TOKEN: 'coolify' });
});

test('APP_SECRETS_OFF skips the read entirely', () => {
  let called = false;
  const env = { APP_SECRETS_OFF: 'true', BOT_TOKEN: 'coolify' };
  const state = loadAppSecrets('bot', { env, fetch: () => { called = true; return null; }, log: recorder().log });
  assert.equal(called, false);
  assert.equal(state.status, 'off');
});

// ── the fetch, with a fake pg client ───────────────────────────────────────
const KEY = 'test-integration-secret-key-0123456789';
const keyEnv = { INTEGRATION_SECRET_KEY: KEY };

function fakeClient({ version, rows = [], versionError = null, seen = [] }) {
  return class {
    async connect() {}
    async end() {}
    async query(sql, params) {
      seen.push({ sql, params });
      if (sql.includes('FROM app_secret_versions')) {
        if (versionError) throw versionError;
        return { rows: version ? [version] : [] };
      }
      return { rows: rows.filter((r) => params[1].includes(r.scope)) };
    }
  };
}

test('the fetch reads "both" then the service\'s own scope, opened with the explicit key only', async () => {
  const rows = [
    { scope: 'both', name: 'A', ciphertext: sharedCrypto.encryptShared('shared', keyEnv) },
    { scope: 'bot', name: 'A', ciphertext: sharedCrypto.encryptShared('mine', keyEnv) },
    { scope: 'samsara', name: 'B', ciphertext: sharedCrypto.encryptShared('theirs', keyEnv) },
  ];
  const version = { id: 9, key_fingerprint: sharedCrypto.fingerprint(keyEnv) };
  const env = { DATABASE_URL: 'postgres://u:p@localhost/db', INTEGRATION_SECRET_KEY: KEY };
  const out = await fetchAppSecrets('bot', env, fakeClient({ version, rows }));
  assert.deepEqual(out, { status: 'loaded', version: 9, values: { A: 'mine' } });
});

test('a value written under the DATABASE_URL-derived key is never opened', async () => {
  const env = { DATABASE_URL: 'postgres://u:p@localhost/db', INTEGRATION_SECRET_KEY: KEY };
  const derived = { DATABASE_URL: env.DATABASE_URL };
  const version = { id: 3, key_fingerprint: sharedCrypto.fingerprint(derived) };
  const out = await fetchAppSecrets('bot', env, fakeClient({ version }));
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /different INTEGRATION_SECRET_KEY/);
});

test('nothing to do without a key, a table, or a version; a pin to a missing version fails', async () => {
  assert.equal((await fetchAppSecrets('bot', { DATABASE_URL: 'postgres://x' })).status, 'skipped');
  assert.equal((await fetchAppSecrets('bot', { INTEGRATION_SECRET_KEY: KEY })).status, 'skipped');
  const env = { DATABASE_URL: 'postgres://u:p@localhost/db', INTEGRATION_SECRET_KEY: KEY };
  const missingTable = Object.assign(new Error('relation does not exist'), { code: '42P01' });
  assert.equal((await fetchAppSecrets('bot', env, fakeClient({ versionError: missingTable }))).status, 'skipped');
  assert.equal((await fetchAppSecrets('bot', env, fakeClient({ version: null }))).status, 'skipped');
  const seen = [];
  const pinned = await fetchAppSecrets('bot', { ...env, APP_SECRETS_VERSION: '7' }, fakeClient({ version: null, seen }));
  assert.equal(pinned.status, 'failed');
  assert.equal(seen[0].params[0], '7');
  assert.equal((await fetchAppSecrets('bot', { ...env, APP_SECRETS_VERSION: 'latest' })).status, 'failed');
  assert.equal((await fetchAppSecrets('nobody', env)).status, 'failed');
});

test('a database error says only its code — never the connection string', async () => {
  const env = { DATABASE_URL: 'postgres://user:hunter2@db.example/x', INTEGRATION_SECRET_KEY: KEY };
  const err = Object.assign(new Error('connect failed for postgres://user:hunter2@db.example/x'), { code: 'ECONNREFUSED' });
  const out = await fetchAppSecrets('bot', env, fakeClient({ versionError: err }));
  assert.equal(out.status, 'failed');
  assert.ok(!out.reason.includes('hunter2'));
});

test('the script prints one JSON line (no database: skipped)', () => {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.INTEGRATION_SECRET_KEY;
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'config', 'appSecretsFetch.js'), 'bot'], { env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.trim()), { status: 'skipped', reason: 'DATABASE_URL is not set' });
});

test('every production entrypoint loads the secrets before config', () => {
  const fs = require('node:fs');
  for (const entry of ['index.js', 'scripts/migrate.js', 'scripts/init-db.js', 'scripts/seed-admin.js']) {
    const src = fs.readFileSync(path.resolve(__dirname, '..', entry), 'utf8');
    const boot = src.indexOf("appSecretsBoot').bootAppSecrets('bot')");
    const config = src.indexOf("config/config').assertRequiredConfig()");
    assert.ok(boot !== -1 && config !== -1 && boot < config, `${entry}: secrets first, then config`);
    const first = src.slice(src.indexOf('require('));
    assert.match(first, /^require\('\.\.?\/config\/appSecretsBoot'\)/, `${entry}: nothing is required before it`);
  }
});
