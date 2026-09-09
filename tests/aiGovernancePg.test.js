/**
 * The AI governance tables, against a real PostgreSQL.
 *
 * Two properties matter more than the CRUD:
 *
 *   NOTHING IS SEEDED, so a boot after this migration behaves exactly as it did
 *   before it — every value NULL, every NULL meaning "inherit the environment".
 *   A migration that seeded a provider row would have changed behaviour on
 *   deploy, which is the one thing an additive migration must never do.
 *
 *   A KEY IS NEVER RETURNED. There is exactly one function that decrypts, it is
 *   named for the router, and the admin mapper cannot be talked into returning
 *   a usable secret.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

function load(harness) {
  return harness.loadDataLayer(['aiProviders', 'aiSettings', 'aiCallLog']);
}

async function harnessWith(t) {
  return createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
}

// ─── the deploy is a no-op ───────────────────────────────────────────────────

test('the migration seeds no provider and no capability', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiProviders, aiSettings } = load(harness);

  assert.deepEqual(await aiProviders.listProvidersForAdmin(), [],
    'a seeded provider would change behaviour on deploy');
  assert.deepEqual(await aiSettings.listCapabilities(), []);
});

test('the settings row exists once and is conservative', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiSettings } = load(harness);

  const settings = await aiSettings.getAiSettings();
  assert.equal(settings.freeOnlyMode, true, 'no paid call until somebody says so');
  assert.equal(settings.routingMode, 'priority');
  assert.equal(settings.requestTimeoutMs, 60000,
    'Gemini has no timeout today; this is the floor that fixes it');

  const rows = await harness.query('SELECT COUNT(*)::int AS n FROM ai_settings');
  assert.equal(rows.rows[0].n, 1, 'single-row table, id = 1');
});

// ─── secrets ─────────────────────────────────────────────────────────────────

test('a stored key is never returned, only masked', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiProviders } = load(harness);

  await aiProviders.upsertProvider('groq', {
    label: 'Groq', enabled: true, apiKey: 'gsk_supersecret_ABCD', updatedBy: 'admin',
  });

  const [admin] = await aiProviders.listProvidersForAdmin();
  assert.equal(admin.apiKeyMasked, '••••ABCD');
  assert.equal(admin.apiKeySet, true);
  assert.equal(JSON.stringify(admin).includes('supersecret'), false,
    'nothing in the admin payload may contain a usable key');

  const [forRouter] = await aiProviders.getProvidersForRouter();
  assert.equal(forRouter.apiKey, 'gsk_supersecret_ABCD',
    'exactly one function decrypts, and it is named for the router');
});

test('omitting the key keeps it; clearing it hands the provider back to the environment',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { aiProviders } = load(harness);
    process.env.GROQ_API_KEY = 'env_key_WXYZ';
    t.after(() => { delete process.env.GROQ_API_KEY; });

    await aiProviders.upsertProvider('groq', { label: 'Groq', enabled: true, apiKey: 'stored_KEY1' });

    await aiProviders.upsertProvider('groq', { priority: 2 });
    let [row] = await aiProviders.listProvidersForAdmin();
    assert.equal(row.apiKeyMasked, '••••KEY1', 'a save that does not mention the key leaves it alone');
    assert.equal(row.priority, 2);

    await aiProviders.upsertProvider('groq', { clearApiKey: true });
    [row] = await aiProviders.listProvidersForAdmin();
    assert.equal(row.apiKeyFromEnv, true);
    assert.equal(row.apiKeySet, true, 'clearing falls back to the environment, it does not break');
    const [forRouter] = await aiProviders.getProvidersForRouter();
    assert.equal(forRouter.apiKey, 'env_key_WXYZ');
  });

// ─── health is recorded, never decided, here ─────────────────────────────────

test('a failure records the cooldown it was given, and success clears it',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { aiProviders } = load(harness);
    await aiProviders.upsertProvider('groq', { label: 'Groq', enabled: true });

    await aiProviders.recordFailure('groq', {
      message: 'quota exceeded',
      cooldown: { until: 'indefinite', reason: 'The credential was rejected.' },
    });
    let [row] = await aiProviders.listProvidersForAdmin();
    assert.equal(row.cooledUntil, 'indefinite');
    assert.equal(row.consecutiveFailures, 1);
    assert.match(row.lastError, /quota exceeded/);

    await aiProviders.recordSuccess('groq');
    [row] = await aiProviders.listProvidersForAdmin();
    assert.equal(row.cooledUntil, null);
    assert.equal(row.consecutiveFailures, 0, 'health is reset, not merely nudged');
  });

test('saving a key clears an indefinite cooldown, because a person just fixed it',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await harnessWith(t);
    const { aiProviders } = load(harness);
    await aiProviders.upsertProvider('groq', { label: 'Groq', enabled: true });
    await aiProviders.recordFailure('groq', {
      message: '401 Unauthorized',
      cooldown: { until: 'indefinite', reason: 'The credential was rejected.' },
    });

    await aiProviders.upsertProvider('groq', { apiKey: 'a_new_key_ABCD' });

    const [row] = await aiProviders.listProvidersForAdmin();
    assert.equal(row.cooledUntil, null,
      'the whole reason it waits indefinitely is that only a person can fix it');
    assert.equal(row.consecutiveFailures, 0);
  });

test('nothing in this module can turn a provider off', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiProviders } = load(harness);
  await aiProviders.upsertProvider('groq', { label: 'Groq', enabled: true });

  await aiProviders.recordFailure('groq', {
    message: 'dead', cooldown: { until: 'indefinite', reason: 'Rejected.' },
  });

  const [row] = await aiProviders.listProvidersForAdmin();
  assert.equal(row.enabled, true,
    '`enabled` is a human decision; software may only stop asking for a while');
});

// ─── the hard line ───────────────────────────────────────────────────────────

test('no capability may ever be granted auto-apply', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiSettings } = load(harness);
  await aiSettings.registerCapability('home_time_intent', { label: 'Home-time intent' });

  await assert.rejects(
    () => harness.query(
      "UPDATE ai_capabilities SET may_auto_apply = TRUE WHERE capability_key = 'home_time_intent'"
    ),
    /ai_capabilities_never_auto_apply/,
    'AI ranks and explains; people and recorded evidence decide'
  );
});

test('a capability records facts about the code, not opinions', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiSettings } = load(harness);

  await aiSettings.registerCapability('chat_annotation', {
    label: 'Chat annotation', sendsRawText: true, hasDeterministicFallback: true,
  });
  // Re-registering (a deploy) refreshes the facts.
  const again = await aiSettings.registerCapability('chat_annotation', {
    label: 'Chat annotation', sendsRawText: true, hasDeterministicFallback: false,
  });
  assert.equal(again.sendsRawText, true, 'shown in the admin so the trade-off is visible');
  assert.equal(again.hasDeterministicFallback, false, 'a fact an operator cannot toggle');

  const updated = await aiSettings.updateCapability('chat_annotation', { aiEnabled: false });
  assert.equal(updated.aiEnabled, false, 'what an operator CAN decide');
});

// ─── telemetry ───────────────────────────────────────────────────────────────

test('the call log holds no prompts and splits failures by class', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiCallLog } = load(harness);

  await aiCallLog.recordAiCall({
    capabilityKey: 'home_time_intent', providerKey: 'groq', model: 'llama-3.1-8b-instant',
    outcome: 'ok', latencyMs: 420,
  });
  await aiCallLog.recordAiCall({
    capabilityKey: 'home_time_intent', providerKey: 'groq', outcome: 'failed',
    failureKind: 'quota', errorMessage: 'daily limit exceeded',
  });

  const [health] = await aiCallLog.summariseProviderHealth({ sinceHours: 24 });
  assert.equal(health.providerKey, 'groq');
  assert.equal(health.ok, 1);
  assert.equal(health.quota, 1);
  assert.equal(health.credential, 0, 'zero-filled: quota and a dead key must not average together');
  assert.equal(health.successPct, 50);

  const columns = await harness.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'ai_call_log'"
  );
  const names = columns.rows.map((r) => r.column_name);
  for (const forbidden of ['prompt', 'completion', 'content', 'text', 'response']) {
    assert.equal(names.some((n) => n === forbidden), false, `ai_call_log must not hold ${forbidden}`);
  }
});

test('telemetry failing never fails the caller', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiCallLog } = load(harness);
  await harness.query('DROP TABLE ai_call_log');

  await aiCallLog.recordAiCall({ providerKey: 'groq', outcome: 'ok' });
  assert.deepEqual(await aiCallLog.summariseProviderHealth(), [],
    'the admin degrades to "no data yet", never to an error card');
  assert.deepEqual(await aiCallLog.listRecentFailures(), []);
});

test('retention prunes what is past its window', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiCallLog } = load(harness);
  await harness.query(
    `INSERT INTO ai_call_log (provider_key, outcome, created_at)
     VALUES ('groq','ok', NOW() - INTERVAL '40 days'), ('groq','ok', NOW())`
  );

  const removed = await aiCallLog.pruneAiCallLog(30);
  assert.equal(removed, 1);
  const left = await harness.query('SELECT COUNT(*)::int AS n FROM ai_call_log');
  assert.equal(left.rows[0].n, 1);
});
