'use strict';

/**
 * Per-model pauses (migration 0074) against a real PostgreSQL: a pause is a
 * jsonb merge that never loses another model's, the router and the admin read
 * it back, an answer clears it, and "Put back in rotation" clears every one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

test('pausing two models keeps both; an answer clears one; the operator clears the rest', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { aiProviders } = harness.loadDataLayer(['aiProviders']);
  const until = new Date(Date.now() + 3600_000);

  await aiProviders.pauseModel('groq', 'openai/gpt-oss-20b', { until, reason: 'tokens per day spent' });
  await aiProviders.pauseModel('groq', 'openai/gpt-oss-120b', { until, reason: 'tokens per day spent' });

  const [groq] = (await aiProviders.getProvidersForRouter()).filter((p) => p.providerKey === 'groq');
  assert.deepEqual(Object.keys(groq.modelCooldowns).sort(), ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  assert.equal(new Date(groq.modelCooldowns['openai/gpt-oss-20b'].until).getTime(), until.getTime());
  assert.equal(groq.cooledUntil, null, 'the provider itself is not cooled');

  await aiProviders.clearModelPause('groq', 'openai/gpt-oss-20b');
  const admin = (await aiProviders.listProvidersForAdmin()).find((p) => p.providerKey === 'groq');
  assert.deepEqual(Object.keys(admin.modelCooldowns), ['openai/gpt-oss-120b']);

  await aiProviders.clearCooldown('groq', 'owner');
  const after = (await aiProviders.listProvidersForAdmin()).find((p) => p.providerKey === 'groq');
  assert.deepEqual(after.modelCooldowns, {});
});

test('an unreadable time pauses nothing', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { aiProviders } = harness.loadDataLayer(['aiProviders']);
  await aiProviders.pauseModel('groq', 'm', { until: 'not a time', reason: 'x' });
  const [groq] = (await aiProviders.getProvidersForRouter()).filter((p) => p.providerKey === 'groq');
  assert.deepEqual(groq.modelCooldowns, {});
});
