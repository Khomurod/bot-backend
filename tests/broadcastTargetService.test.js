const test = require('node:test');
const assert = require('node:assert/strict');

const ACTIVE = { id: 1, group_name: 'A', active: true, language: 'en' };
const INACTIVE = { id: 2, group_name: 'B', active: false, language: 'en' };
const INACTIVE_RU = { id: 3, group_name: 'C', active: false, language: 'ru' };

const calls = [];

const db = {
  getGroupsByIds: async (ids) => {
    calls.push(['getGroupsByIds', ids]);
    return ids.includes(1) ? [ACTIVE] : [];
  },
  getGroupsByIdsForAdmin: async (ids) => {
    calls.push(['getGroupsByIdsForAdmin', ids]);
    const all = [ACTIVE, INACTIVE, INACTIVE_RU];
    return all.filter((g) => ids.includes(g.id));
  },
  getGroupsByLanguages: async (langs) => {
    calls.push(['getGroupsByLanguages', langs]);
    return [ACTIVE].filter((g) => langs.includes(g.language));
  },
  getDriverGroupsByLanguagesAndActiveFilter: async (langs, filter) => {
    calls.push(['getDriverGroupsByLanguagesAndActiveFilter', langs, filter]);
    const pool = filter === 'inactive' ? [INACTIVE, INACTIVE_RU] : [ACTIVE, INACTIVE, INACTIVE_RU];
    return pool.filter((g) => langs.includes(g.language));
  },
  getAllDriverGroups: async () => {
    calls.push(['getAllDriverGroups']);
    return [ACTIVE];
  },
  getDriverGroupsByActiveFilter: async (filter) => {
    calls.push(['getDriverGroupsByActiveFilter', filter]);
    if (filter === 'inactive') return [INACTIVE, INACTIVE_RU];
    if (filter === 'all') return [ACTIVE, INACTIVE, INACTIVE_RU];
    return [ACTIVE];
  },
};

require.cache[require.resolve('../database/db')] = { exports: db };
const {
  normalizeActiveFilter,
  resolveBroadcastTargetGroups,
} = require('../services/broadcastTargetService');

test('normalizeActiveFilter defaults to active', () => {
  assert.equal(normalizeActiveFilter({}), 'active');
  assert.equal(normalizeActiveFilter({ target_active_filter: null }), 'active');
  assert.equal(normalizeActiveFilter({ target_active_filter: 'all' }), 'all');
  assert.equal(normalizeActiveFilter({ target_active_filter: 'inactive' }), 'inactive');
});

test('target all with default uses getAllDriverGroups only', async () => {
  calls.length = 0;
  const groups = await resolveBroadcastTargetGroups({ target_type: 'all' });
  assert.deepEqual(groups, [ACTIVE]);
  assert.deepEqual(calls, [['getAllDriverGroups']]);
});

test('target all with inactive filter uses new query', async () => {
  calls.length = 0;
  const groups = await resolveBroadcastTargetGroups({
    target_type: 'all',
    target_active_filter: 'inactive',
  });
  assert.equal(groups.length, 2);
  assert.ok(calls.some((c) => c[0] === 'getDriverGroupsByActiveFilter' && c[1] === 'inactive'));
  assert.equal(calls.some((c) => c[0] === 'getAllDriverGroups'), false);
});

test('language_groups active uses legacy getGroupsByLanguages', async () => {
  calls.length = 0;
  await resolveBroadcastTargetGroups({
    target_type: 'language_groups',
    target_languages: ['en'],
    target_active_filter: 'active',
  });
  assert.deepEqual(calls, [['getGroupsByLanguages', ['en']]]);
});

test('language_groups inactive uses filtered language query', async () => {
  calls.length = 0;
  const groups = await resolveBroadcastTargetGroups({
    target_type: 'language_groups',
    target_languages: ['en'],
    target_active_filter: 'inactive',
  });
  assert.deepEqual(groups, [INACTIVE]);
  assert.deepEqual(calls, [['getDriverGroupsByLanguagesAndActiveFilter', ['en'], 'inactive']]);
});

test('specific_drivers uses admin id resolver', async () => {
  calls.length = 0;
  const groups = await resolveBroadcastTargetGroups({
    target_type: 'specific_drivers',
    target_driver_ids: [2],
  });
  assert.deepEqual(groups, [INACTIVE]);
  assert.deepEqual(calls, [['getGroupsByIdsForAdmin', [2]]]);
});

test('legacy group_ids path still uses active-only getGroupsByIds', async () => {
  calls.length = 0;
  await resolveBroadcastTargetGroups({ group_ids: [1] });
  assert.deepEqual(calls, [['getGroupsByIds', [1]]]);
});
