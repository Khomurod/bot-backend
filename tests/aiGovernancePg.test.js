/**
 * The AI governance tables, against a real PostgreSQL.
 *
 * Two properties matter more than the CRUD:
 *
 *   WHAT IS SEEDED IS EXACTLY TODAY'S BEHAVIOUR, and no more. Migration 0019
 *   seeded nothing at all, which was right while the router had no consumers.
 *   Once the two clients became wrappers over it (Stage 5c), an empty roster
 *   stopped meaning "unchanged" and started meaning "every AI call in the
 *   application fails" — so 0021 writes down the two providers that are already
 *   in use, with NULL keys, and NULL still means "inherit the environment".
 *   Nothing is seeded that was not already true.
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

test('the roster is the two providers already in use, and only registered capabilities', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiProviders, aiSettings } = load(harness);

  const providers = await aiProviders.listProvidersForAdmin();
  assert.deepEqual(providers.map((p) => p.providerKey).sort(), ['gemini', 'groq'],
    'an EMPTY roster is what would change behaviour now: getProvidersForRouter '
    + 'selects WHERE enabled = TRUE, so nothing enabled means every AI call fails');
  assert.ok(providers.every((p) => p.enabled), 'both are in use today, in the only sense there is');
  // A capability row is a SWITCH, not a grant: `may_auto_apply` is CHECKed to
  // FALSE in the schema, so registering one can never widen what AI may do. The
  // rows that exist are the ones a migration registered deliberately, because a
  // capability the router honours but never registers is a switch Settings → AI
  // cannot show and an administrator cannot reach.
  const capabilities = await aiSettings.listCapabilities();
  assert.deepEqual(capabilities.map((c) => c.capabilityKey).sort(), ['home_time_return_to_road'],
    'exactly the capabilities a migration registered — nothing appears by accident');
  assert.ok(capabilities.every((c) => c.mayAutoApply === false),
    'no registered capability may apply a correction, and the schema refuses TRUE outright');
  assert.ok(capabilities.every((c) => c.mayPropose === false),
    'proposing is off until a human turns it on');
});

test('the seed stores no key — the environment is still where it comes from', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const rows = await harness.query(
    'SELECT provider_key, api_key_encrypted, api_key_last4 FROM ai_providers ORDER BY provider_key'
  );
  for (const row of rows.rows) {
    assert.equal(row.api_key_encrypted, null,
      `${row.provider_key}: a migration that wrote a key would be a secret in a SQL file`);
    assert.equal(row.api_key_last4, null);
  }
});

test('the seed carries a real model chain, or the router has nothing to ask', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiProviders } = load(harness);
  const byKey = new Map((await aiProviders.listProvidersForAdmin()).map((p) => [p.providerKey, p]));

  assert.ok(byKey.get('groq').modelChain.length >= 2);
  assert.ok(byKey.get('gemini').modelChain.length >= 2);
  assert.equal(byKey.get('groq').adapter, 'openai_chat');
  assert.equal(byKey.get('gemini').adapter, 'gemini');
  assert.ok(byKey.get('groq').priority < byKey.get('gemini').priority,
    'Groq first, which is the order all nine hand-coded "try Groq, then Gemini" branches already use');
});

test('re-running the seed does NOT overwrite what an operator configured', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiProviders } = load(harness);

  await aiProviders.upsertProvider('groq', {
    label: 'Groq (ours)', enabled: false, priority: 99, apiKey: 'sk-operator-key',
  });

  // The migration is idempotent; running its INSERT again must change nothing.
  await harness.query(`
    INSERT INTO ai_providers (provider_key, label, adapter, enabled, priority, is_free, base_url, model_chain)
    VALUES ('groq', 'Groq', 'openai_chat', TRUE, 10, TRUE, 'https://api.groq.com/openai/v1', '["x"]'::jsonb)
    ON CONFLICT (provider_key) DO NOTHING`);

  const after = (await aiProviders.listProvidersForAdmin()).find((p) => p.providerKey === 'groq');
  assert.equal(after.label, 'Groq (ours)');
  assert.equal(after.enabled, false, 'a deliberate disable must survive a redeploy');
  assert.equal(after.priority, 99);
  assert.ok(after.apiKeySet, 'and the stored key must not be silently replaced by the env var');
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

// ─── migration 0023: discovery ───────────────────────────────────────────────

test('0023 labels the two seeded providers with their catalogue entry and nothing else', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const rows = await harness.query('SELECT provider_key, catalog_key, discovered_models, models_refreshed_at FROM ai_providers ORDER BY provider_key');
  for (const row of rows.rows) {
    assert.equal(row.catalog_key, row.provider_key, `${row.provider_key}: a refresh needs to know where its models endpoint is`);
    assert.deepEqual(row.discovered_models, [], 'nothing was discovered yet — the migration does not call anyone');
    assert.equal(row.models_refreshed_at, null);
  }
});

test('discovery results and model events round-trip through the data layer', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiProviders, aiModelEvents } = harness.loadDataLayer(['aiProviders', 'aiModelEvents']);

  await aiProviders.saveDiscoveredModels('groq', {
    models: [{ id: 'llama-3.1-8b-instant', contextLength: 131072, chat: true, free: 'free' }],
  });
  let [admin] = (await aiProviders.listProvidersForAdmin()).filter((p) => p.providerKey === 'groq');
  assert.equal(admin.discoveredModels[0].id, 'llama-3.1-8b-instant');
  assert.ok(admin.modelsRefreshedAt, 'a successful listing is timestamped');
  assert.equal(admin.modelsRefreshError, null);

  await aiProviders.saveDiscoveredModels('groq', { error: '503 Service Unavailable' });
  [admin] = (await aiProviders.listProvidersForAdmin()).filter((p) => p.providerKey === 'groq');
  assert.equal(admin.discoveredModels[0].id, 'llama-3.1-8b-instant', 'a failed listing keeps the last good one');
  assert.equal(admin.modelsRefreshError, '503 Service Unavailable');

  const ev = await aiModelEvents.recordModelEvent({
    providerKey: 'groq', model: 'mixtral-8x7b-32768', event: 'retired', initiator: 'refresh',
    detail: { replacement: 'openai/gpt-oss-20b' },
  });
  assert.equal(ev.event, 'retired');
  const listed = await aiModelEvents.listModelEvents({ providerKey: 'groq' });
  assert.equal(listed[0].detail.replacement, 'openai/gpt-oss-20b');
  await assert.rejects(() => aiModelEvents.recordModelEvent({ providerKey: 'groq', event: 'vanished' }), /Unknown model event/);
  await assert.rejects(
    () => harness.query(`INSERT INTO ai_model_events (provider_key, event) VALUES ('groq', 'vanished')`),
    /check constraint/i, 'the schema refuses an event the vocabulary does not have',
  );
});

test('a policy source remembers who chose its URL, and a re-add keeps the first answer', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiPolicy } = harness.loadDataLayer(['aiPolicy']);

  const typed = await aiPolicy.addSource({ providerKey: 'groq', url: 'https://groq.com/terms-of-use/', kind: 'terms' });
  assert.equal(typed.sourceOrigin, 'manual', 'the default is a person');

  const reseeded = await aiPolicy.addSource({
    providerKey: 'groq', url: 'https://groq.com/terms-of-use/', kind: 'terms', sourceOrigin: 'catalog',
  });
  assert.equal(reseeded.sourceOrigin, 'manual', 'a catalogue seed must not relabel a URL a person typed first');

  const seeded = await aiPolicy.addSource({
    providerKey: 'groq', url: 'https://groq.com/privacy-policy/', kind: 'privacy', sourceOrigin: 'catalog',
  });
  assert.equal(seeded.sourceOrigin, 'catalog');

  await assert.rejects(
    () => harness.query(`INSERT INTO ai_policy_sources (provider_key, url, kind, source_origin) VALUES ('groq', 'https://x', 'terms', 'guessed')`),
    /check constraint/i,
  );
});

test('0024: a retirement is pending until it has been told, and the stamp is idempotent', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { aiModelEvents } = harness.loadDataLayer(['aiModelEvents']);
  const a = await aiModelEvents.recordModelEvent({ providerKey: 'groq', model: 'old-a', event: 'retired', initiator: 'refresh' });
  await aiModelEvents.recordModelEvent({ providerKey: 'groq', model: 'new', event: 'added', initiator: 'refresh' });
  const b = await aiModelEvents.recordModelEvent({ providerKey: 'groq', model: 'old-b', event: 'retired', initiator: 'router' });

  let pending = await aiModelEvents.listUnnotifiedRetirements('groq');
  assert.deepEqual(pending.map((e) => e.model), ['old-a', 'old-b'], 'only retirements, oldest first');
  assert.equal(pending[0].notifiedAt, null);

  assert.equal(await aiModelEvents.markEventsNotified([a.id]), 1);
  pending = await aiModelEvents.listUnnotifiedRetirements('groq');
  assert.deepEqual(pending.map((e) => e.model), ['old-b']);
  assert.equal(await aiModelEvents.markEventsNotified([a.id, b.id]), 1, 'already-stamped rows are not re-stamped');
  assert.deepEqual(await aiModelEvents.listUnnotifiedRetirements('groq'), []);
});
