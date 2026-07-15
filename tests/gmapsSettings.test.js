const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const RAW_KEY = 'AIzaSyFakeSecretKey1234';

/**
 * Load database/gmapsSettings with a mutable fake db, a reversible fake crypto,
 * and a controllable config, injected via require.cache.
 */
function loadModule({ config = {} } = {}) {
  const modPath = path.resolve(__dirname, '../database/gmapsSettings.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const cryptoPath = path.resolve(__dirname, '../services/facebookCrypto.js');
  const configPath = path.resolve(__dirname, '../config/config.js');
  for (const p of [modPath, dbPath, cryptoPath, configPath]) delete require.cache[p];

  const store = { id: 1, updated_at: null };
  require.cache[dbPath] = {
    exports: {
      async query(sql, values = []) {
        if (/UPDATE gmaps_settings/.test(sql)) {
          const assigns = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE')).split(',');
          for (const clause of assigns) {
            const m = clause.match(/(\w+)\s*=\s*(\$(\d+)|NULL|NOW\(\))/);
            if (!m) continue;
            const col = m[1];
            if (m[2] === 'NULL') store[col] = null;
            else if (m[2] === 'NOW()') store[col] = new Date().toISOString();
            else store[col] = values[Number(m[3]) - 1];
          }
          return { rows: [] };
        }
        if (/SELECT \* FROM gmaps_settings/.test(sql)) return { rows: [{ ...store }] };
        return { rows: [] };
      },
    },
  };
  // Reversible fake crypto so we can assert round-tripping without a real key.
  require.cache[cryptoPath] = {
    exports: {
      encryptText: (s) => `enc:${s}`,
      decryptText: (s) => String(s).replace(/^enc:/, ''),
    },
  };
  require.cache[configPath] = { exports: { googleMapsApiKey: '', ...config } };

  return { mod: require(modPath), store };
}

test('saving the API key stores it encrypted, not in plaintext', async () => {
  const { mod, store } = loadModule();
  await mod.updateGmapsSettings({ serverApiKey: RAW_KEY, enabled: true });
  assert.equal(store.server_api_key_encrypted, `enc:${RAW_KEY}`);
  assert.notEqual(store.server_api_key_encrypted, RAW_KEY);
});

test('the admin view masks the key and never returns the raw value', async () => {
  const { mod } = loadModule();
  await mod.updateGmapsSettings({ serverApiKey: RAW_KEY, enabled: true });
  const view = await mod.getGmapsSettingsForAdmin();
  assert.equal(view.serverApiKeySet, true);
  assert.equal(view.serverApiKeyMasked, '••••1234');
  assert.equal(view.enabled, true);
  // The raw key must not appear anywhere in the admin payload.
  assert.doesNotMatch(JSON.stringify(view), new RegExp(RAW_KEY));
});

test('the effective server-side config decrypts the key for API calls', async () => {
  const { mod } = loadModule();
  await mod.updateGmapsSettings({ serverApiKey: RAW_KEY });
  const cfg = await mod.getGmapsConfig();
  assert.equal(cfg.serverApiKey, RAW_KEY);
  assert.equal(cfg.serverApiKeyFromEnv, false);
});

test('an empty stored key falls back to the GOOGLE_MAPS_API_KEY env value', async () => {
  const { mod } = loadModule({ config: { googleMapsApiKey: 'ENV-KEY-9999' } });
  const cfg = await mod.getGmapsConfig();
  assert.equal(cfg.serverApiKey, 'ENV-KEY-9999');
  assert.equal(cfg.serverApiKeyFromEnv, true);
  const view = await mod.getGmapsSettingsForAdmin();
  assert.equal(view.serverApiKeyFromEnv, true);
  assert.equal(view.serverApiKeyMasked, '••••9999');
});

test('numeric tunables round-trip and default sanely', async () => {
  const { mod } = loadModule();
  const view = await mod.updateGmapsSettings({ deviationThresholdMeters: 500, offRouteGraceChecks: 4 });
  assert.equal(view.deviationThresholdMeters, 500);
  assert.equal(view.offRouteGraceChecks, 4);
  // Untouched fields keep their defaults.
  assert.equal(view.warningCooldownMinutes, 30);
  assert.equal(view.staleGpsMinutes, 15);
});

test('route completion radius defaults to 50 mi and clamps to the 1–100 range', async () => {
  const { mod } = loadModule();
  // Default when never set (fresh database → 50, the authoritative constant).
  assert.equal((await mod.getGmapsConfig()).routeCompletionRadiusMiles, 50);
  // Round-trips a valid value.
  let view = await mod.updateGmapsSettings({ routeCompletionRadiusMiles: 7.5 });
  assert.equal(view.routeCompletionRadiusMiles, 7.5);
  // Clamps out-of-range values (recommended range 1–100).
  view = await mod.updateGmapsSettings({ routeCompletionRadiusMiles: 999 });
  assert.equal(view.routeCompletionRadiusMiles, 100);
  view = await mod.updateGmapsSettings({ routeCompletionRadiusMiles: 0.1 });
  assert.equal(view.routeCompletionRadiusMiles, 1);
  // Junk input is ignored (value left unchanged), never crashes the update.
  view = await mod.updateGmapsSettings({ routeCompletionRadiusMiles: 'not-a-number' });
  assert.equal(view.routeCompletionRadiusMiles, 1);
});

test('the single authoritative radius constant is exported and used everywhere', () => {
  const { ROUTE_COMPLETION_RADIUS_MILES } = require('../services/routeControlConstants');
  assert.equal(ROUTE_COMPLETION_RADIUS_MILES.DEFAULT, 50);
  assert.equal(ROUTE_COMPLETION_RADIUS_MILES.MIN, 1);
  assert.equal(ROUTE_COMPLETION_RADIUS_MILES.MAX, 100);
});

test('the one-shot completion-radius schema migrations are present (10→35, then 35→50)', () => {
  // The radius bumps happen in database/schema.sql (one-shot, marker-guarded).
  // Guard the migration text here so a refactor can't silently drop it.
  const fs = require('node:fs');
  const schema = fs.readFileSync(path.resolve(__dirname, '../database/schema.sql'), 'utf-8');
  // The effective column default is now 50 mi.
  assert.match(schema, /ALTER COLUMN route_completion_radius_miles SET DEFAULT 50/);
  // History: the original 10 → 35 bump is still present and marker-guarded.
  assert.match(schema, /completion_radius_35_migrated = FALSE AND route_completion_radius_miles = 10/);
  // The new 35 → 50 bump, guarded by its own one-shot marker.
  assert.match(schema, /completion_radius_50_migrated = FALSE AND route_completion_radius_miles = 35/);
  assert.match(schema, /uniq_route_assignment_attachment/);
});
