'use strict';

/**
 * The provider order and the Claude adapter, against a real PostgreSQL.
 *
 * Migration 0071 widens 0019's adapter CHECK so a Claude provider can be saved
 * at all; `setProviderOrder` writes the operator's order — first is primary,
 * the rest fall back in turn — in one statement, and refuses an order built
 * from a page that no longer matches the roster.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  return { harness, ...harness.loadDataLayer(['aiProviders']) };
}

test('a Claude provider can be saved; an unknown adapter still cannot', { skip: skipWithoutPg() }, async (t) => {
  const { aiProviders } = await setup(t);
  const saved = await aiProviders.upsertProvider('anthropic', {
    label: 'Anthropic Claude', adapter: 'anthropic', isFree: false,
    baseUrl: 'https://api.anthropic.com', modelChain: ['claude-haiku-5-5'],
  });
  assert.equal(saved.adapter, 'anthropic');
  await assert.rejects(
    aiProviders.upsertProvider('bogus', { adapter: 'carrier_pigeon' }),
    /violates check constraint/
  );
});

test('THE ORDER CHOSEN IS THE ORDER ASKED: first is primary, the rest in turn', { skip: skipWithoutPg() }, async (t) => {
  const { aiProviders } = await setup(t);
  await aiProviders.upsertProvider('anthropic', { adapter: 'anthropic', modelChain: ['claude-haiku-5-5'] });
  const before = (await aiProviders.listProvidersForAdmin()).map((p) => p.providerKey);
  assert.equal(before.length, 3);

  const result = await aiProviders.setProviderOrder(['anthropic', 'gemini', 'groq'], { updatedBy: 'owner' });
  assert.equal(result.ok, true);
  const after = await aiProviders.listProvidersForAdmin();
  assert.deepEqual(after.map((p) => [p.providerKey, p.priority]),
    [['anthropic', 10], ['gemini', 20], ['groq', 30]]);
  assert.ok(after.every((p) => p.updatedBy === 'owner'));
});

test('an order from a stale page is refused and nothing moves', { skip: skipWithoutPg() }, async (t) => {
  const { aiProviders } = await setup(t);
  const before = (await aiProviders.listProvidersForAdmin()).map((p) => [p.providerKey, p.priority]);
  for (const bad of [['groq'], ['groq', 'groq'], ['groq', 'gemini', 'ghost'], null]) {
    const r = await aiProviders.setProviderOrder(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.match(r.error, /reload/);
  }
  const after = (await aiProviders.listProvidersForAdmin()).map((p) => [p.providerKey, p.priority]);
  assert.deepEqual(after, before);
});

test('a Claude workspace id is stored, read back by the router, cleared by an empty string, and a non-id is refused', { skip: skipWithoutPg() }, async (t) => {
  const { aiProviders } = await setup(t);
  await aiProviders.upsertProvider('anthropic', { adapter: 'anthropic', enabled: true, workspaceId: 'wrkspc_01ABC' });
  const routed = (await aiProviders.getProvidersForRouter()).find((p) => p.providerKey === 'anthropic');
  assert.equal(routed.workspaceId, 'wrkspc_01ABC');
  assert.equal((await aiProviders.getProviderSecretsByKey('anthropic')).workspaceId, 'wrkspc_01ABC');

  await aiProviders.upsertProvider('anthropic', { label: 'Claude' });
  assert.equal((await aiProviders.getProviderSecretsByKey('anthropic')).workspaceId, 'wrkspc_01ABC', 'omitting it keeps it');

  await aiProviders.upsertProvider('anthropic', { workspaceId: '' });
  assert.equal((await aiProviders.getProviderSecretsByKey('anthropic')).workspaceId, null);

  await assert.rejects(aiProviders.upsertProvider('anthropic', { workspaceId: 'drop table' }), (e) => e.statusCode === 400);
});
