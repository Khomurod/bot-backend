/**
 * `groups.samsara_vehicle_id` against a real database.
 *
 * The pure resolution is tested in `vehicleLinkResolution.test.js`; what needs a
 * real Postgres is the round trip — that the scan's row source actually hands
 * back the column the "do not rewrite an unchanged link" guard reads, and that
 * what the writer stores is what the reader finds.
 *
 * The row-source assertion is the one worth having. If `listActiveDriverUnits`
 * stopped selecting `samsara_vehicle_id`, every row would arrive with it
 * undefined, every link would look new, and the scan would UPDATE all 209 rows
 * every fifteen minutes — forever, silently, and with every test above still
 * passing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function seedDriverGroup(harness, { id, telegramId, name, unit, first, last, active = true }) {
  await harness.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES ($1, $2, $3, 'driver', $4)`,
    [id, telegramId, name, active]
  );
  await harness.query(
    `INSERT INTO driver_profiles (group_id, unit_number, first_name, last_name)
     VALUES ($1, $2, $3, $4)`,
    [id, unit, first, last]
  );
}

test('the writer stores a link the reader finds', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { groups } = harness.loadDataLayer(['groups']);

  await seedDriverGroup(harness, {
    id: 1, telegramId: '-100', name: 'WENZE UNIT # 100 JOHN DOE', unit: '100',
    first: 'JOHN', last: 'DOE',
  });

  assert.equal(await groups.getGroupBySamsaraId('v-100'), null, 'nothing is linked yet');

  const updated = await groups.updateGroupSamsaraId(1, 'v-100');
  assert.equal(updated.samsara_vehicle_id, 'v-100');

  const found = await groups.getGroupBySamsaraId('v-100');
  assert.equal(found.id, 1);
});

test('an inactive group is not reachable by its stored vehicle id', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { groups } = harness.loadDataLayer(['groups']);

  await seedDriverGroup(harness, {
    id: 1, telegramId: '-100', name: 'WENZE UNIT # 100 JOHN DOE', unit: '100',
    first: 'JOHN', last: 'DOE', active: false,
  });
  await groups.updateGroupSamsaraId(1, 'v-100');

  assert.equal(await groups.getGroupBySamsaraId('v-100'), null,
    'a retired truck must not keep routing a live alert');
});

test('the scan row source carries the current link', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = harness.loadDataLayer(['groups', 'duplicateUnitReports']);

  await seedDriverGroup(harness, {
    id: 1, telegramId: '-100', name: 'WENZE UNIT # 100 JOHN DOE', unit: '100',
    first: 'JOHN', last: 'DOE',
  });
  await seedDriverGroup(harness, {
    id: 2, telegramId: '-200', name: 'WENZE UNIT # 200 JANE ROE', unit: '200',
    first: 'JANE', last: 'ROE',
  });
  await layer.groups.updateGroupSamsaraId(1, 'v-100');

  const rows = await layer.duplicateUnitReports.listActiveDriverUnits();
  const byId = new Map(rows.map((r) => [r.group_id, r]));
  assert.equal(rows.length, 2);
  assert.ok('samsara_vehicle_id' in byId.get(1),
    'without this column every scan rewrites every row, forever and silently');
  assert.equal(byId.get(1).samsara_vehicle_id, 'v-100');
  assert.equal(byId.get(2).samsara_vehicle_id, null);
});

test('a handover leaves exactly one holder of the vehicle', { skip: skipWithoutPg() }, async (t) => {
  // The write half of the exclusivity rule. Unit 305 moved from group 1 to
  // group 2; both halves of the handover have to land, or `getGroupBySamsaraId`
  // answers with LIMIT 1 — an arbitrary driver, silently.
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = harness.loadDataLayer(['groups', 'duplicateUnitReports']);
  const service = require('../services/duplicateUnitCheckService');

  await seedDriverGroup(harness, {
    id: 1, telegramId: '-100', name: 'WENZE UNIT # 400 JOHN DOE', unit: '400',
    first: 'JOHN', last: 'DOE',
  });
  await seedDriverGroup(harness, {
    id: 2, telegramId: '-200', name: 'WENZE UNIT # 305 JANE ROE', unit: '305',
    first: 'JANE', last: 'ROE',
  });
  await layer.groups.updateGroupSamsaraId(1, 'v-305');

  const rows = await layer.duplicateUnitReports.listActiveDriverUnits();
  const links = service.resolveVehicleLinks(rows, [
    { id: 'v-305', name: '305 JANE ROE', gps: { time: '2026-09-01T00:00:00Z' } },
  ]);

  // Written through the real data layer, not the module-level pool.
  for (const link of links) {
    // eslint-disable-next-line no-await-in-loop
    await layer.groups.updateGroupSamsaraId(link.groupId, link.vehicleId);
  }

  const held = await harness.query(
    "SELECT id FROM groups WHERE samsara_vehicle_id = 'v-305' ORDER BY id"
  );
  assert.deepEqual(held.rows.map((r) => r.id), [2], 'one vehicle, one holder');
  const found = await layer.groups.getGroupBySamsaraId('v-305');
  assert.equal(found.id, 2);
});
