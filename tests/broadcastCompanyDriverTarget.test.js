/**
 * Who a "company drivers" broadcast actually reaches.
 *
 * The target filter matched the literal string '(COMPANY DRIVER)' — with the
 * closing bracket and no plural — while the fleet's real team titles are
 * '(COMPANY DRIVERS)'. Every one of those groups was silently dropped from
 * every company-driver broadcast, and nothing anywhere reported a group it had
 * decided not to message. These tests pin the plural, because the singular form
 * still exists too and a fix that swapped one literal for the other would be
 * the same bug facing the other way.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const SINGULAR = { id: 1, group_name: 'WENZE UNIT # 100 JOHN DOE (COMPANY DRIVER)', active: true };
const PLURAL = { id: 2, group_name: 'WENZE UNIT # 200 TEAM (COMPANY DRIVERS)', active: true };
const LOWER = { id: 3, group_name: 'Wenze unit # 300 company drivers', active: true };
const OWNER = { id: 4, group_name: 'WENZE UNIT # 400 JANE ROE (OWNER OPERATOR)', active: true };
const INACTIVE_PLURAL = { id: 5, group_name: 'WENZE UNIT # 500 TEAM (COMPANY DRIVERS)', active: false };

const ALL = [SINGULAR, PLURAL, LOWER, OWNER, INACTIVE_PLURAL];

require.cache[require.resolve('../database/db')] = {
  exports: {
    getAllDriverGroups: async () => ALL.filter((g) => g.active),
    getDriverGroupsByActiveFilter: async (filter) => (
      filter === 'inactive' ? ALL.filter((g) => !g.active) : ALL
    ),
  },
};

const { resolveBroadcastTargetGroups } = require('../services/broadcastTargetService');

test('a company-driver broadcast reaches the PLURAL team titles', async () => {
  const groups = await resolveBroadcastTargetGroups({ target_type: 'company_drivers' });
  const ids = groups.map((g) => g.id).sort();
  assert.deepEqual(ids, [1, 2, 3],
    'the plural and lower-case titles are company-driver groups too');
});

test('owner-operators are still excluded', async () => {
  const groups = await resolveBroadcastTargetGroups({ target_type: 'company_drivers' });
  assert.equal(groups.some((g) => g.id === OWNER.id), false);
});

test('the active filter still decides the pool, not the title test', async () => {
  const groups = await resolveBroadcastTargetGroups({
    target_type: 'company_drivers', target_active_filter: 'inactive',
  });
  assert.deepEqual(groups.map((g) => g.id), [INACTIVE_PLURAL.id]);
});
