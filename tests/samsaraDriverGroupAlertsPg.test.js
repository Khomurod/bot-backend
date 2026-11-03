/**
 * The Samsara driver-group switch, against a real PostgreSQL.
 *
 *   THE DEPLOY CHANGES NOTHING. Every group that exists when migration 0090
 *   runs reads ON, and so does every group registered afterwards — nothing
 *   stops posting because a column appeared.
 *
 *   ONLY A DRIVER GROUP CAN BE SWITCHED, and only the one asked for. A team
 *   shares one chat and therefore one switch; another driver's group is never
 *   touched.
 *
 *   THE CHOICE FOLLOWS THE CHAT. A Telegram supergroup upgrade moves the
 *   `groups` row to the new id in place, and the switch moves with it.
 *
 *   WHAT THE SAMSARA SERVICE READS is the column itself, on the routed row —
 *   the read at the bottom is the one it runs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { buildCanonicalDriverGroups } = require('../services/driverGroupDirectoryService');

const BEFORE_0090 = allMigrationsSql((name) => name < '0090_');
const ONLY_0090 = allMigrationsSql((name) => name.startsWith('0090_'));
const ALL = allMigrationsSql();

async function addGroup(h, { chatId, name, type = 'driver', active = true }) {
  const res = await h.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [chatId, name, type, active]
  );
  return Number(res.rows[0].id);
}

async function flagOf(h, id) {
  const res = await h.query('SELECT samsara_driver_alerts_enabled AS on FROM groups WHERE id = $1', [id]);
  return res.rows[0].on;
}

test('groups that exist before 0090 read ON after it, and so do groups created later', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: BEFORE_0090 });
  const old = await addGroup(h, { chatId: -1001, name: 'Unit 101 John Carter' });
  const inactive = await addGroup(h, { chatId: -1002, name: 'Unit 102 Old Driver', active: false });

  await h.query(ONLY_0090);
  assert.equal(await flagOf(h, old), true);
  assert.equal(await flagOf(h, inactive), true);

  const later = await addGroup(h, { chatId: -1003, name: 'Unit 103 New Driver' });
  assert.equal(await flagOf(h, later), true, 'a group registered after the deploy starts ON');

  // Idempotent, like every boot.
  await h.query(ONLY_0090);
  assert.equal(await flagOf(h, old), true);
});

test('switching one driver group off and on touches that group only, and reports what it replaced', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL });
  const { samsaraDriverGroupAlerts: store } = h.loadDataLayer(['samsaraDriverGroupAlerts']);
  const john = await addGroup(h, { chatId: -2001, name: 'Unit 201 John Carter' });
  const team = await addGroup(h, { chatId: -2002, name: 'Unit 202 Ali Khan & Bo Lee' });

  const off = await store.setSamsaraDriverAlertsEnabled(john, false);
  assert.deepEqual(off, { status: 'ok', groupId: john, groupName: 'Unit 201 John Carter', previous: true, enabled: false });
  assert.equal(await flagOf(h, john), false);
  assert.equal(await flagOf(h, team), true, 'another driver group is never touched');

  const again = await store.setSamsaraDriverAlertsEnabled(john, false);
  assert.equal(again.previous, false, 'a repeat is harmless and says it was already off');

  const on = await store.setSamsaraDriverAlertsEnabled(john, true);
  assert.equal(on.previous, false);
  assert.equal(on.enabled, true);
  assert.equal(await flagOf(h, john), true);
});

test('a chat that is not a driver group cannot be switched, and a missing one is reported', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL });
  const { samsaraDriverGroupAlerts: store } = h.loadDataLayer(['samsaraDriverGroupAlerts']);
  const office = await addGroup(h, { chatId: -3001, name: 'Wenze Dispatch Team', type: 'employee' });

  assert.deepEqual(await store.setSamsaraDriverAlertsEnabled(office, false), { status: 'not_driver', groupType: 'employee' });
  assert.equal(await flagOf(h, office), true, 'nothing was written');
  assert.deepEqual(await store.setSamsaraDriverAlertsEnabled(999999, false), { status: 'not_found' });
  await assert.rejects(() => store.setSamsaraDriverAlertsEnabled(office, 'false'), /boolean/);
});

test('Driver Groups shows the saved value on the row for that group', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL });
  const { db, samsaraDriverGroupAlerts: store } = h.loadDataLayer(['db', 'samsaraDriverGroupAlerts']);
  const john = await addGroup(h, { chatId: -4001, name: 'Unit 401 John Carter' });
  const maria = await addGroup(h, { chatId: -4002, name: 'Unit 402 Maria Lopez' });
  await store.setSamsaraDriverAlertsEnabled(john, false);

  const rows = buildCanonicalDriverGroups(await db.listGroupDirectorySourceRows({ includeNonDrivers: true }));
  const byId = new Map(rows.map((r) => [r.group_id, r]));
  assert.equal(byId.get(john).samsara_driver_alerts_enabled, false);
  assert.equal(byId.get(maria).samsara_driver_alerts_enabled, true);
});

test('a Telegram supergroup upgrade carries the switch to the new chat id', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL });
  const { samsaraDriverGroupAlerts: store, telegramChatMigration } = h.loadDataLayer(['samsaraDriverGroupAlerts', 'telegramChatMigration']);
  const john = await addGroup(h, { chatId: -5052301861, name: 'Unit 501 John Carter' });
  await store.setSamsaraDriverAlertsEnabled(john, false);

  const moved = await telegramChatMigration.followChatMigration('-5052301861', '-1005052301861');
  assert.equal(moved.groupMoved, 1);
  const res = await h.query(
    'SELECT id, samsara_driver_alerts_enabled AS on FROM groups WHERE telegram_group_id = $1', ['-1005052301861']
  );
  assert.deepEqual(res.rows.map((r) => ({ id: Number(r.id), on: r.on })), [{ id: john, on: false }]);
});

test('the read the Samsara service runs, by group id and by chat id', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL });
  const { samsaraDriverGroupAlerts: store } = h.loadDataLayer(['samsaraDriverGroupAlerts']);
  const john = await addGroup(h, { chatId: -6001, name: 'Unit 601 John Carter' });
  await store.setSamsaraDriverAlertsEnabled(john, false);

  // samsara-integration src/store.js → isDriverGroupAlertsEnabled, verbatim.
  const byId = await h.query('SELECT samsara_driver_alerts_enabled FROM groups WHERE id = $1', [john]);
  assert.equal(byId.rows[0].samsara_driver_alerts_enabled, false);
  const byChat = await h.query(
    'SELECT samsara_driver_alerts_enabled FROM groups WHERE telegram_group_id::text = $1', ['-6001']
  );
  assert.equal(byChat.rows[0].samsara_driver_alerts_enabled, false);
});
