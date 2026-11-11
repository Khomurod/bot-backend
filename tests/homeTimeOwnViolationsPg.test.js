'use strict';

/**
 * Migration 0103 on a real PostgreSQL: Wenze decides by default and starts
 * once; its rows are keyed by driver group + home stay + violation and
 * inserted once, even by two passes at the same moment; a driver's own rule
 * is one at a time; the cycles the pass reads come back by group. Names are
 * made up.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer(['homeTime/violationNotices', 'homeTime/policyExceptions', 'homeTime/violationCycles']);
  const g = await h.pool.query("INSERT INTO groups (telegram_group_id, group_name, group_type) VALUES (-100555, 'WENZE UNIT 012', 'driver') RETURNING id");
  return {
    h,
    store: layer['homeTime/violationNotices'],
    rules: layer['homeTime/policyExceptions'],
    cycles: layer['homeTime/violationCycles'],
    groupId: g.rows[0].id,
  };
}

const stay = (groupId, over = {}) => ({
  groupId, homeFrom: '2026-11-12', violations: ['early', 'overstay'], driverName: 'Kwame Asante', roadDays: 18, homeDays: 6, ...over,
});

test('WENZE DECIDES BY DEFAULT, and the start is set once', { skip: skipWithoutPg() }, async (t) => {
  const { store } = await setup(t);
  const settings = await store.getViolationSettings();
  assert.equal(settings.violation_source, 'wenze');
  assert.equal(settings.own_violations_since, null);
  const first = await store.startOwnViolations();
  assert.ok(first);
  assert.equal(String(await store.startOwnViolations()), String(first), 'never moved once set');
});

test('ONE ROW PER VIOLATION PER STAY — two passes at once insert each once; the card note is kept', { skip: skipWithoutPg() }, async (t) => {
  const { store, groupId } = await setup(t);
  const [a, b] = await Promise.all([store.recordOwnViolations(stay(groupId)), store.recordOwnViolations(stay(groupId))]);
  assert.equal(a.length + b.length, 2);
  assert.deepEqual([...a, ...b].map((r) => [r.source, r.deal_id]).sort(), [['wenze', null], ['wenze', null]]);
  assert.equal((await store.recordOwnViolations(stay(groupId, { homeFrom: '2026-12-20' }))).length, 2, 'the next stay is new');
  const rows = [...a, ...b];
  await store.setBitrixNote(rows.map((r) => r.id), { dealId: 77, note: 'card moved to C33:UC_HTEARLYOVER' });
  const due = await store.listDue();
  assert.ok(due.some((r) => r.deal_id === '77' && r.group_id === groupId));

  const own = await store.recordOwnViolations(stay(groupId, { homeFrom: '2027-01-05', rule: { exception: true, roadDays: 21, homeDays: 3 } }));
  assert.deepEqual([own[0].rule_road_days, own[0].rule_home_days], [21, 3]);
});

test("A DRIVER'S OWN RULE: one at a time, replaced and removed", { skip: skipWithoutPg() }, async (t) => {
  const { rules, groupId } = await setup(t);
  await rules.setException({ groupId, roadDays: 21, homeDays: 3, note: '3 and 3' }, 'admin');
  await rules.setException({ groupId, roadDays: 14, homeDays: null, validUntil: '2026-12-31' }, 'admin');
  const active = await rules.listActiveExceptions();
  assert.equal(active.length, 1);
  assert.deepEqual([active[0].roadDays, active[0].homeDays, active[0].validUntil, active[0].groupName], [14, null, '2026-12-31', 'WENZE UNIT 012']);
  assert.equal(await rules.removeException(active[0].id), true);
  assert.equal((await rules.listActiveExceptions()).length, 0);
  assert.ok((await rules.listDriverGroups()).some((g) => g.id === groupId));
});

test('the cycles the pass judges come back by driver group, with the driver type', { skip: skipWithoutPg() }, async (t) => {
  const { h, cycles, groupId } = await setup(t);
  await h.pool.query(`INSERT INTO driver_profiles (group_id, first_name, last_name, driver_type) VALUES ($1, 'Kwame', 'Asante', 'company_driver')`, [groupId]);
  await h.pool.query(`INSERT INTO driver_road_history (group_id, driver_name, road_started_at, home_arrived_at, days_on_road)
                      VALUES ($1, 'x', '2026-10-25', '2026-11-12', 18)`, [groupId]);
  const byGroup = await cycles.listCyclesByGroup('2026-10-01');
  const [row] = byGroup.get(groupId);
  assert.deepEqual([row.driverName, row.driverType, row.returnToRoadAt], ['Kwame Asante', 'company_driver', null]);
});
