/**
 * Migration 0027: the owner's three switches, and catalogue identity for
 * legacy AI provider rows.
 *
 * The load-bearing assertions are the ones about what the migration does NOT
 * do: a setting an administrator already saved is left exactly as saved (the
 * seed is a person's switch written once, not a policy re-asserted on every
 * boot), a custom provider is never given a catalogue URL, and the whole file
 * re-applies as a no-op — it runs inside initializeDatabase(), where a failing
 * statement takes the application down.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const BEFORE_0027 = allMigrationsSql((name) => !name.startsWith('0027_'));
const MIGRATION_0027 = fs.readFileSync(
  path.join(__dirname, '..', 'database', 'migrations', '0027_production_repair_permissions_and_legacy_providers.sql'),
  'utf8',
);

const EXPECTED = {
  'identity.group_without_person': { enabled: true, cap: 150 },
  'identity.stale_unit_assignment': { enabled: true, cap: 150 },
  'home_time.closable_open_cycle': { enabled: true, cap: 65 },
};

async function settings(harness) {
  const res = await harness.query(
    'SELECT check_key, auto_apply_enabled, max_auto_per_run, updated_by FROM operational_check_settings ORDER BY check_key'
  );
  return Object.fromEntries(res.rows.map((r) => [r.check_key, r]));
}

test('the three repairs are switched on with their measured caps', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: allMigrationsSql() });
  const rows = await settings(harness);
  for (const [key, want] of Object.entries(EXPECTED)) {
    assert.ok(rows[key], `${key} has a settings row`);
    assert.equal(rows[key].auto_apply_enabled, want.enabled, key);
    assert.equal(rows[key].max_auto_per_run, want.cap, `${key} cap is the safety limit, not a way around it`);
    assert.match(rows[key].updated_by, /migration 0027/, 'the row says who switched it on');
  }
  assert.equal(rows['home_time.returned_to_road'].max_auto_per_run, 25,
    'migration 0030 adds the automatic return-to-road switch, with its own cap');
  assert.equal(Object.keys(rows).length, 4, 'and no other check is touched');
});

test('a setting an administrator already saved is left exactly as saved', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: BEFORE_0027 });
  await harness.query(
    `INSERT INTO operational_check_settings (check_key, auto_apply_enabled, max_auto_per_run, updated_by, mode)
     VALUES ('home_time.closable_open_cycle', FALSE, 10, 'admin:7', 'suggest')`
  );
  await harness.query(MIGRATION_0027);
  const rows = await settings(harness);
  assert.equal(rows['home_time.closable_open_cycle'].auto_apply_enabled, false, 'the person\'s switch wins');
  assert.equal(rows['home_time.closable_open_cycle'].max_auto_per_run, 10);
  assert.equal(rows['home_time.closable_open_cycle'].updated_by, 'admin:7');
  assert.equal(rows['identity.group_without_person'].auto_apply_enabled, true, 'the others are still seeded');
});

test('a legacy Gemini row gains its catalogue key and Base URL; a custom row is untouched', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: BEFORE_0027 });
  // Migration 0021 seeds Gemini with base_url NULL — production's exact shape —
  // and 0023 later stamps its catalog_key. Strip both to the oldest legacy
  // form, and give Groq an operator-set URL of its own.
  await harness.query("UPDATE ai_providers SET base_url = NULL, catalog_key = NULL WHERE provider_key = 'gemini'");
  await harness.query("UPDATE ai_providers SET base_url = 'https://proxy.example/v1', catalog_key = NULL WHERE provider_key = 'groq'");
  await harness.query(
    `INSERT INTO ai_providers (provider_key, label, adapter, base_url, catalog_key)
     VALUES ('my_llm', 'Office box', 'openai_chat', NULL, 'custom')`
  );
  await harness.query(MIGRATION_0027);
  const res = await harness.query('SELECT provider_key, base_url, catalog_key FROM ai_providers ORDER BY provider_key');
  const by = Object.fromEntries(res.rows.map((r) => [r.provider_key, r]));
  assert.equal(by.gemini.catalog_key, 'gemini');
  assert.equal(by.gemini.base_url, 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(by.my_llm.base_url, null, 'there is no catalogue URL for a custom endpoint');
  assert.equal(by.my_llm.catalog_key, 'custom');
  assert.equal(by.groq.catalog_key, 'groq');
  assert.equal(by.groq.base_url, 'https://proxy.example/v1', 'a Base URL the operator set is theirs');
});

test('the seeded Gemini row — production\'s shape — ends up with the catalogue URL', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: allMigrationsSql() });
  const res = await harness.query("SELECT base_url, catalog_key FROM ai_providers WHERE provider_key = 'gemini'");
  assert.equal(res.rows[0].catalog_key, 'gemini');
  assert.equal(res.rows[0].base_url, 'https://generativelanguage.googleapis.com/v1beta');
});

test('the migration re-applies as a no-op', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: allMigrationsSql() });
  await harness.query(
    `UPDATE operational_check_settings SET auto_apply_enabled = FALSE, mode = 'suggest', updated_by = 'admin:1'
      WHERE check_key = 'identity.stale_unit_assignment'`
  );
  await harness.query(MIGRATION_0027);
  const rows = await settings(harness);
  assert.equal(rows['identity.stale_unit_assignment'].auto_apply_enabled, false, 'switching it off in the admin sticks across boots');
  assert.equal(Object.keys(rows).length, 4);
});

test('the migration URLs are the catalogue\'s, character for character', () => {
  // The SQL cannot import the catalogue, so this is the only thing keeping the
  // two from drifting apart.
  const { getCatalogEntry } = require('../lib/ai/providerCatalog');
  for (const key of ['groq', 'gemini', 'openrouter', 'cerebras', 'mistral', 'together', 'deepseek', 'nvidia']) {
    const line = new RegExp(`WHEN '${key}'\\s+THEN '${getCatalogEntry(key).baseUrl.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'`);
    assert.match(MIGRATION_0027, line, `${key}: ${getCatalogEntry(key).baseUrl}`);
  }
});
