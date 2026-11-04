'use strict';

/**
 * Migration 0091, database/appSecrets.js, the boot read and the Samsara key
 * move on a real PostgreSQL: a version saved through the service is what the
 * boot script loads, each service reads only its own scopes, the table refuses
 * a malformed row, and the stored Samsara key moves under
 * INTEGRATION_SECRET_KEY exactly once.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { createSecretsService } = require('../services/appSecrets/secretsService');
const sharedCrypto = require('../lib/security/sharedIntegrationCrypto');

const ALL_MIGRATIONS = allMigrationsSql();
const KEY = 'pg-test-integration-key-0123456789abcdef';
const T1 = '111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const T2 = '222222:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2';
const T3 = '333333:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA3';

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${h.schema}`;
  const { appSecrets: store } = h.loadDataLayer(['appSecrets']);
  const svc = createSecretsService({
    store,
    keyEnv: () => ({ INTEGRATION_SECRET_KEY: KEY }),
    hostEnv: () => ({ JWT_SECRET: 'jwt-host', FACEBOOK_TOKEN_ENCRYPTION_KEY: 'fb-host' }),
    bootState: () => ({ status: 'not-run', names: [], overridden: [] }),
    checkTelegramToken: async () => ({ ok: true, username: '@bot' }),
  });
  return { h, svc, databaseUrl: url.toString() };
}

function bootRead(target, env) {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'config', 'appSecretsFetch.js'), target], {
    env: { PATH: process.env.PATH, ...env }, encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('the table refuses a malformed name or an unknown scope', { skip: skipWithoutPg() }, async (t) => {
  const { h } = await setup(t);
  const id = (await h.query("INSERT INTO app_secret_versions (key_fingerprint) VALUES ('f') RETURNING id")).rows[0].id;
  await assert.rejects(h.query("INSERT INTO app_secret_values (version_id, scope, name, ciphertext) VALUES ($1, 'bot', 'lower', 'x')", [id]));
  await assert.rejects(h.query("INSERT INTO app_secret_values (version_id, scope, name, ciphertext) VALUES ($1, 'everyone', 'A', 'x')", [id]));
  await h.query("INSERT INTO app_secret_values (version_id, scope, name, ciphertext) VALUES ($1, 'bot', 'A_1', 'x')", [id]);
});

test('what the page saves is what each service loads at boot — its own scopes only', { skip: skipWithoutPg() }, async (t) => {
  const { svc, databaseUrl } = await setup(t);
  assert.deepEqual(bootRead('bot', { DATABASE_URL: databaseUrl, INTEGRATION_SECRET_KEY: KEY }),
    { status: 'skipped', reason: 'nothing is stored yet' });

  await svc.save({ target: 'bot', text: `BOT_TOKEN=${T1}\nTELEGRAM_BOT_TOKEN=${T2}\nJWT_SECRET=jwt-stored-value\n`, baseVersion: null });
  await svc.save({ target: 'samsara', text: `SAMSARA_BOT_TOKEN=${T3}\nUSE_WEBHOOK=false\n`, baseVersion: 1 });

  const bot = bootRead('bot', { DATABASE_URL: databaseUrl, INTEGRATION_SECRET_KEY: KEY });
  assert.equal(bot.status, 'loaded');
  assert.equal(bot.version, 2);
  assert.deepEqual(bot.values, { BOT_TOKEN: T1, TELEGRAM_BOT_TOKEN: T2, JWT_SECRET: 'jwt-stored-value' });

  const samsara = bootRead('samsara', { DATABASE_URL: databaseUrl, INTEGRATION_SECRET_KEY: KEY });
  assert.deepEqual(samsara.values, { BOT_TOKEN: T1, SAMSARA_BOT_TOKEN: T3, USE_WEBHOOK: 'false' });

  // The previous version on request; the wrong key opens nothing.
  const pinned = bootRead('bot', { DATABASE_URL: databaseUrl, INTEGRATION_SECRET_KEY: KEY, APP_SECRETS_VERSION: '1' });
  assert.equal(pinned.version, 1);
  const wrong = bootRead('bot', { DATABASE_URL: databaseUrl, INTEGRATION_SECRET_KEY: 'not-the-key-000000000000' });
  assert.equal(wrong.status, 'failed');
  assert.ok(!JSON.stringify(wrong).includes(T1));
});

test('restoring a version writes a new one equal to it', { skip: skipWithoutPg() }, async (t) => {
  const { h, svc } = await setup(t);
  await svc.save({ target: 'bot', text: `BOT_TOKEN=${T1}\nTELEGRAM_BOT_TOKEN=${T2}\n`, baseVersion: null });
  await svc.save({ target: 'bot', text: `BOT_TOKEN=${T3}\nTELEGRAM_BOT_TOKEN=${T2}\n`, baseVersion: 1 });
  const out = await svc.restore({ versionId: 1 });
  assert.deepEqual(out, { versionId: 3, restoredFrom: 1 });
  const rows = (await h.query('SELECT name, ciphertext FROM app_secret_values WHERE version_id = 3 ORDER BY name')).rows;
  const first = (await h.query('SELECT name, ciphertext FROM app_secret_values WHERE version_id = 1 ORDER BY name')).rows;
  assert.deepEqual(rows, first);
  const view = await svc.getView();
  assert.deepEqual(view.versions.map((v) => v.id), [3, 2, 1]);
  assert.equal(view.versions[0].restoredFrom, 1);
});

test('the stored Samsara key moves under INTEGRATION_SECRET_KEY once, and only from the derived key', { skip: skipWithoutPg() }, async (t) => {
  const { h } = await setup(t);
  const { samsaraSettings } = h.loadDataLayer(['samsaraSettings']);
  const derivedEnv = { DATABASE_URL: 'postgres://wenze:db-password@db.example:5432/postgres' };
  const env = { ...derivedEnv, INTEGRATION_SECRET_KEY: KEY };
  const run = (text, values) => h.query(text, values);

  assert.deepEqual(await samsaraSettings.moveApiKeyToExplicitKey(derivedEnv, run), { status: 'no-explicit-key' });
  await h.query('INSERT INTO samsara_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
  assert.deepEqual(await samsaraSettings.moveApiKeyToExplicitKey(env, run), { status: 'nothing-stored' });

  await h.query('UPDATE samsara_settings SET api_key_encrypted = $1, api_key_fingerprint = $2 WHERE id = 1',
    [sharedCrypto.encryptShared('samsara_api_key_value', derivedEnv), sharedCrypto.fingerprint(derivedEnv)]);
  assert.deepEqual(await samsaraSettings.moveApiKeyToExplicitKey(env, run), { status: 'moved' });
  const row = (await h.query('SELECT api_key_encrypted, api_key_fingerprint FROM samsara_settings WHERE id = 1')).rows[0];
  assert.equal(row.api_key_fingerprint, sharedCrypto.fingerprint(env));
  assert.equal(sharedCrypto.decryptShared(row.api_key_encrypted, env), 'samsara_api_key_value');
  assert.deepEqual(await samsaraSettings.moveApiKeyToExplicitKey(env, run), { status: 'already' });

  // Written under some third key: left alone, never guessed at.
  await h.query("UPDATE samsara_settings SET api_key_fingerprint = 'someone-else' WHERE id = 1");
  assert.deepEqual(await samsaraSettings.moveApiKeyToExplicitKey(env, run), { status: 'unknown-key' });
});
