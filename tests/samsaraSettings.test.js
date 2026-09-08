/**
 * The admin side of the Samsara settings row.
 *
 * The three rules that matter to a live deployment:
 *   · the CURRENTLY DEPLOYED key keeps working with nothing entered and
 *     nothing migrated — an empty column means "inherit the environment";
 *   · a save that does not mention the key LEAVES IT ALONE, so tuning the
 *     recovery settings can never wipe the working credential;
 *   · the key never comes back out — reads mask it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL ||= 'postgresql://user:password@localhost:5432/test';
process.env.JWT_SECRET ||= 'test-jwt-secret';
process.env.BOT_TOKEN ||= 'test-bot-token';
process.env.PORT ||= '3001';

const DB_PATH = require.resolve('../database/db');
const CONFIG_PATH = require.resolve('../config/config');
const MODULE_PATH = require.resolve('../database/samsaraSettings');
const ELD_PATH = require.resolve('../database/eldSettings');

/**
 * Load the module against a fake single-row table.
 * `writes` collects every UPDATE so a test can assert what a save touched.
 */
function loadModule({ row = null, envKey = '' } = {}) {
  const writes = [];
  let current = row;
  require.cache[DB_PATH] = {
    exports: {
      query: async (text, values) => {
        if (/SELECT \* FROM samsara_settings/.test(text)) return { rows: current ? [current] : [] };
        if (/^INSERT INTO samsara_settings/.test(text.trim())) return { rows: [] };
        if (/^UPDATE samsara_settings/.test(text.trim())) {
          writes.push({ text, values });
          return { rows: [] };
        }
        return { rows: [] };
      },
    },
  };
  require.cache[CONFIG_PATH] = {
    exports: { samsaraApiKey: envKey, samsaraApiKeys: envKey ? [envKey] : [], samsaraApiBase: 'https://api.samsara.com' },
  };
  // eldSettings is invalidated on save; stub it so the lazy require is inert.
  require.cache[ELD_PATH] = { exports: { invalidateCache: () => {} } };
  delete require.cache[MODULE_PATH];
  const mod = require(MODULE_PATH);
  const restore = () => {
    for (const path of [DB_PATH, CONFIG_PATH, MODULE_PATH, ELD_PATH]) delete require.cache[path];
  };
  return { mod, writes, restore, setRow: (next) => { current = next; } };
}

test('with nothing saved, the deployed environment key is what runs', async () => {
  const { mod, restore } = loadModule({ row: null, envKey: 'env-samsara-key' });
  try {
    const cfg = await mod.getSamsaraConfig();
    assert.equal(cfg.apiKey, 'env-samsara-key');
    assert.equal(cfg.apiKeySource, 'environment');
    assert.equal(cfg.videoRecoveryInitialDelaySeconds, 300, 'the shipped default is 5 minutes');

    const view = await mod.getSamsaraSettingsForAdmin();
    assert.equal(view.apiKeySet, true, 'the panel shows Samsara as already configured');
    assert.equal(view.apiKeyFromEnv, true);
    assert.equal(view.apiKeyMasked, '••••-key');
  } finally { restore(); }
});

test('the masked view never contains the key', async () => {
  const sharedCrypto = require('../lib/security/sharedIntegrationCrypto');
  const { mod, restore } = loadModule({
    row: { id: 1, enabled: true, api_key_encrypted: sharedCrypto.encryptShared('samsara_live_abcd1234'), api_key_last4: '1234' },
    envKey: '',
  });
  try {
    const view = await mod.getSamsaraSettingsForAdmin();
    assert.equal(JSON.stringify(view).includes('samsara_live_abcd1234'), false);
    assert.equal(view.apiKeyMasked, '••••1234');
    assert.equal(view.apiKeySource, 'database');
  } finally { restore(); }
});

test('a save that does not mention the key leaves the stored one alone', async () => {
  const sharedCrypto = require('../lib/security/sharedIntegrationCrypto');
  const stored = sharedCrypto.encryptShared('working-key');
  const { mod, writes, restore } = loadModule({
    row: { id: 1, enabled: true, api_key_encrypted: stored, api_key_last4: '-key' },
  });
  try {
    await mod.updateSamsaraSettings({ videoRecoveryInitialDelaySeconds: 600, videoRecoveryEnabled: true });
    assert.equal(writes.length, 1);
    assert.doesNotMatch(writes[0].text, /api_key_encrypted/, 'the working credential is untouched');
    assert.match(writes[0].text, /video_recovery_initial_delay_seconds/);
  } finally { restore(); }
});

test('a new key is stored encrypted, with its fingerprint and last four', async () => {
  const { mod, writes, restore } = loadModule({ row: { id: 1, enabled: true } });
  try {
    await mod.updateSamsaraSettings({ apiKey: '  samsara_live_wxyz9876  ' });
    const { text, values } = writes[0];
    assert.match(text, /api_key_encrypted = \$1/);
    assert.match(text, /api_key_fingerprint/);
    assert.notEqual(values[0], 'samsara_live_wxyz9876', 'never stored in the clear');
    assert.equal(require('../lib/security/sharedIntegrationCrypto').decryptShared(values[0]), 'samsara_live_wxyz9876');
    assert.equal(values[2], '9876', 'the last four, so the panel can mask a key it cannot decrypt');
  } finally { restore(); }
});

test('clearing the key hands Samsara back to the environment variable', async () => {
  const { mod, writes, restore } = loadModule({ row: { id: 1, enabled: true, api_key_encrypted: 'x' } });
  try {
    await mod.updateSamsaraSettings({ clearApiKey: true });
    assert.match(writes[0].text, /api_key_encrypted = NULL/);
    assert.match(writes[0].text, /api_key_fingerprint = NULL/);
  } finally { restore(); }
});

test('out-of-range numbers are clamped to what the database will accept', async () => {
  const { mod, writes, restore } = loadModule({ row: { id: 1, enabled: true } });
  try {
    await mod.updateSamsaraSettings({
      videoRecoveryInitialDelaySeconds: 1,          // below the 30s floor
      videoRecoveryMaxAttempts: 100000,             // above the 200 ceiling
      videoRetrievalWindowAfterSeconds: 45,
    });
    const values = writes[0].values;
    assert.ok(values.includes(30), 'a typo becomes a legal value, not a 500');
    assert.ok(values.includes(200));
    assert.ok(values.includes(45));
  } finally { restore(); }
});

test('a key this server cannot decrypt is reported, not mistaken for "none saved"', async () => {
  const { mod, restore } = loadModule({
    row: { id: 1, enabled: true, api_key_encrypted: 'not.a.valid-envelope', api_key_last4: '4321' },
    envKey: 'env-samsara-key',
  });
  try {
    const view = await mod.getSamsaraSettingsForAdmin();
    assert.equal(view.apiKeyUnreadable, true);
    assert.equal(view.apiKeySource, 'environment', 'and Samsara keeps running on the deployed key');
  } finally { restore(); }
});
