/**
 * The person layer, kept true while the fleet moves — against a real PostgreSQL.
 *
 * Every scenario here is one the production data already contains:
 *
 *   A truck change: unit 320 → 322 is the same driver, recorded as a change of
 *   truck, not a second person.
 *   An old truck with a new driver: the truck's previous holder keeps it until a
 *   human says otherwise — a chat title does not evict anybody.
 *   A returning driver: group 49 went inactive, group 541877 appeared with the
 *   same name; the person, and every row written about them, is the same row.
 *   Stamping at write: every operational fact recorded from now on carries the
 *   person it is about, or NULL when the layer has not met the group.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { POOL_PATH, purgeDataLayer } = require('./helpers/purgeDataLayer');

const ALL_MIGRATIONS = allMigrationsSql();
const RESOLVER = path.resolve(__dirname, '../services/identity/personResolver.js');
const BACKFILL = path.resolve(__dirname, '../services/identity/personBackfillService.js');

/**
 * Bind the resolver AND the data layer to the throwaway database. The stub is
 * installed while the modules load and removed after, so nothing later in the
 * process inherits it; the loaded modules keep the pool they captured.
 */
function bind(harness) {
  const extras = [RESOLVER, BACKFILL];
  purgeDataLayer(extras);
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true,
    exports: { pool: harness.pool, query: harness.query, ping: async () => true },
  };
  try {
    const resolver = require(RESOLVER);
    resolver.resetResolverCache();
    return {
      resolver,
      people: require('../database/driverPeople'),
      roadHistory: require('../database/homeTime/roadHistory'),
      driverState: require('../database/homeTime/driverState'),
      requests: require('../database/homeTime/requests'),
      fuel: require('../database/fuelMonitoring'),
      routes: require('../database/routeControl/assignments'),
      teams: require('../database/raiseApproval/teamDrivers'),
      mileage: require('../database/mileageBonus'),
    };
  } finally {
    delete require.cache[POOL_PATH];
    purgeDataLayer(extras);
  }
}

async function seedGroup(harness, { telegramId, name, first, last, unit, telegramUserId = null, active = true }) {
  const g = await harness.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active) VALUES ($1, $2, 'driver', $3) RETURNING *`,
    [telegramId, name, active]
  );
  const group = g.rows[0];
  const p = await harness.query(
    `INSERT INTO driver_profiles (group_id, first_name, last_name, unit_number, telegram_user_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [group.id, first, last, unit, telegramUserId]
  );
  return { group, profile: p.rows[0] };
}

const personOf = async (harness, groupId) => (await harness.query(
  'SELECT person_id FROM driver_person_groups WHERE group_id = $1 AND ended_at IS NULL', [groupId]
)).rows[0]?.person_id ?? null;

test('a driver group seen for the first time gets a person, and its history is stamped', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { resolver } = bind(harness);
  const { group } = await seedGroup(harness, { telegramId: -101, name: 'WENZE UNIT # 320 SIROJIDDIN DAVUROV', first: 'SIROJIDDIN', last: 'DAVUROV', unit: '320' });
  // History written BEFORE the layer met the group — the production case.
  await harness.query(
    `INSERT INTO driver_road_history (group_id, road_started_at, home_arrived_at, days_on_road, bonus_usd)
     VALUES ($1, NOW() - INTERVAL '40 days', NOW() - INTERVAL '5 days', 35, 100)`, [group.id]
  );

  const result = await resolver.ensurePersonForGroup(group);

  assert.equal(result.action, 'create');
  const personId = await personOf(harness, group.id);
  assert.equal(personId, result.personId);
  const person = await harness.query('SELECT * FROM driver_people WHERE id = $1', [personId]);
  assert.equal(person.rows[0].display_name, 'SIROJIDDIN DAVUROV');
  assert.equal(person.rows[0].created_source, 'bot');
  const stamped = await harness.query('SELECT person_id FROM driver_road_history WHERE group_id = $1', [group.id]);
  assert.equal(stamped.rows[0].person_id, personId, 'the leg written before the layer knew them is theirs');

  // Second sight within the TTL is a cache hit; forced, a keep. Neither creates.
  assert.equal((await resolver.ensurePersonForGroup(group)).action, 'cached');
  assert.equal((await resolver.ensurePersonForGroup(group, { force: true })).action, 'keep');
  const n = await harness.query('SELECT COUNT(*)::int AS n FROM driver_people');
  assert.equal(n.rows[0].n, 1);
});

test('every operational write carries the person from now on — and NULL, never an error, before the layer knows the group', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const bound = bind(harness);
  const { group } = await seedGroup(harness, { telegramId: -102, name: 'WENZE UNIT # 27 RUSLAN ABDULLAEV', first: 'RUSLAN', last: 'ABDULLAEV', unit: '27' });

  // Before: the resolver has not met this group.
  const early = await bound.roadHistory.insertRoadHistory({
    groupId: group.id, driverName: 'RUSLAN ABDULLAEV', unitNumber: '27',
    roadStartedAt: new Date(Date.now() - 30 * 86400000).toISOString(), homeArrivedAt: new Date().toISOString(),
    daysOnRoad: 30, exceededWeeks: 0, bonusUsd: 0,
  });
  assert.equal(early.person_id, null);

  const { personId } = await bound.resolver.ensurePersonForGroup(group);
  assert.ok(personId);
  // The early leg was stamped by the resolver.
  assert.equal((await harness.query('SELECT person_id FROM driver_road_history WHERE id = $1', [early.id])).rows[0].person_id, personId);

  const leg = await bound.roadHistory.insertRoadHistory({
    groupId: group.id, driverName: 'RUSLAN ABDULLAEV', unitNumber: '27',
    roadStartedAt: new Date().toISOString(), homeArrivedAt: new Date().toISOString(),
    daysOnRoad: 1, exceededWeeks: 0, bonusUsd: 0,
  });
  assert.equal(leg.person_id, personId, 'driver_road_history');

  const status = await bound.driverState.upsertDriverHomeStatus({
    groupId: group.id, telegramGroupId: -102, state: 'road', stateSince: new Date().toISOString(),
    lastStatusText: 'rolling', lastStatusAt: new Date().toISOString(),
  });
  assert.equal(status.person_id, personId, 'driver_home_status');

  const request = await bound.requests.insertHomeTimeRequest({
    groupId: group.id, telegramGroupId: -102, driverName: 'RUSLAN ABDULLAEV', requestedAt: new Date().toISOString(),
  });
  assert.equal(request.person_id, personId, 'home_time_requests');

  const alert = await bound.fuel.createFuelStopAlert({
    groupId: group.id, telegramGroupId: -102, sourceMessageId: 5, stationLat: 41.8, stationLng: -87.6,
  });
  assert.equal(alert.person_id, personId, 'fuel_stop_alerts');

  const route = await bound.routes.createRouteAssignment({
    groupId: group.id, driverProfileId: null, driverLabel: 'RUSLAN', unitNumber: '27',
    originalUrl: 'https://maps.example/x', originText: 'A', destinationText: 'B', waypoints: [],
    encodedPolyline: 'abc', distanceMeters: 1000, durationSeconds: 60, assignedBy: 'admin',
  });
  assert.equal(route.person_id, personId, 'route_assignments');

  const team = await harness.query(`INSERT INTO dispatch_teams (name) VALUES ('Team A') RETURNING id`);
  const { assignment } = await bound.teams.assignDriverToTeam({
    teamId: team.rows[0].id, groupId: group.id, driverName: 'RUSLAN ABDULLAEV', driverNormalizedName: 'RUSLAN ABDULLAEV',
  });
  assert.equal(assignment.person_id, personId, 'dispatch_team_drivers');

  // Mileage is keyed on a NAME. One canonical person with that name → stamped.
  const progress = await bound.mileage.upsertDriverProgress({
    driver_normalized_name: 'RUSLAN ABDULLAEV', driver_name: 'Ruslan Abdullaev', total_miles: 1200,
  });
  assert.equal(progress.person_id, personId, 'mileage_bonus_progress');
});

test('a truck change is recorded as a change of truck; a truck somebody else holds is not taken', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { resolver } = bind(harness);
  const a = await seedGroup(harness, { telegramId: -201, name: 'WENZE UNIT # 320 SIROJIDDIN DAVUROV', first: 'SIROJIDDIN', last: 'DAVUROV', unit: '320' });
  const b = await seedGroup(harness, { telegramId: -202, name: 'WENZE UNIT # 001 OLABODE OLUDAISI', first: 'OLABODE', last: 'OLUDAISI', unit: '001' });
  const pa = (await resolver.ensurePersonForGroup(a.group)).personId;
  const pb = (await resolver.ensurePersonForGroup(b.group)).personId;

  // The decision names the whole truck now, not just its number: a seat, and a
  // fleet the resolver could not determine (`unknown`, which never wins a
  // match). The resolver becomes fleet-aware in A3b.
  assert.deepEqual(await resolver.syncUnitForPerson(pa, '320'),
    { action: 'open', from: null, to: '320', seat: 1, fleetType: 'unknown' });
  assert.deepEqual(await resolver.syncUnitForPerson(pa, '322'),
    { action: 'switch', from: '320', to: '322', seat: 1, fleetType: 'unknown' });
  const units = await harness.query(
    'SELECT unit_number, ended_at IS NULL AS open FROM driver_units WHERE person_id = $1 ORDER BY started_at, id', [pa]
  );
  assert.deepEqual(units.rows.map((r) => [r.unit_number, r.open]), [['320', false], ['322', true]],
    'the same person, two trucks in time');

  // B is recorded in 322 by a chat title while A still holds it.
  const contested = await resolver.syncUnitForPerson(pb, '322');
  assert.equal(contested.action, 'contested');
  assert.equal(contested.holderPersonId, pa);
  const holder = await harness.query("SELECT person_id FROM driver_units WHERE unit_number = '322' AND ended_at IS NULL");
  assert.equal(holder.rows[0].person_id, pa, 'the previous holder keeps the truck');
  const bUnits = await harness.query('SELECT COUNT(*)::int AS n FROM driver_units WHERE person_id = $1', [pb]);
  assert.equal(bUnits.rows[0].n, 0, 'nothing was written for the contested claim');
});

test('a returning driver on a new chat is the SAME person, and the road history follows', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { resolver } = bind(harness);
  const old = await seedGroup(harness, { telegramId: -49, name: 'WENZE UNIT # 27 RUSLAN ABDULLAEV', first: 'RUSLAN', last: 'ABDULLAEV', unit: '27' });
  const { personId } = await resolver.ensurePersonForGroup(old.group);
  await harness.query(
    `INSERT INTO driver_road_history (group_id, person_id, road_started_at, home_arrived_at, days_on_road, bonus_usd)
     VALUES ($1, $2, NOW() - INTERVAL '40 days', NOW() - INTERVAL '10 days', 30, 100)`, [old.group.id, personId]
  );
  // The truck changed; the old chat went inactive; a new chat appeared.
  await harness.query('UPDATE groups SET active = FALSE WHERE id = $1', [old.group.id]);
  const fresh = await seedGroup(harness, { telegramId: -541877, name: 'WENZE UNIT # 27 RUSLAN ABDULLAEV', first: 'RUSLAN', last: 'ABDULLAEV', unit: '27' });
  await harness.query(
    `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at) VALUES ($1, 'road', NOW(), NOW())`,
    [fresh.group.id]
  );

  const result = await resolver.ensurePersonForGroup(fresh.group);

  assert.equal(result.action, 'link');
  assert.equal(result.personId, personId, 'one human, not two');
  const associations = await harness.query(
    'SELECT group_id, ended_at IS NULL AS open, association_source FROM driver_person_groups WHERE person_id = $1 ORDER BY id', [personId]
  );
  assert.deepEqual(associations.rows.map((r) => [r.group_id, r.open, r.association_source]),
    [[old.group.id, false, 'bot'], [fresh.group.id, true, 'name_key']]);
  const status = await harness.query('SELECT person_id FROM driver_home_status WHERE group_id = $1', [fresh.group.id]);
  assert.equal(status.rows[0].person_id, personId, 'the new chat\'s status row is theirs');
  // The person's whole history is one query now.
  const legs = await harness.query('SELECT COUNT(*)::int AS n FROM driver_road_history WHERE person_id = $1', [personId]);
  assert.equal(legs.rows[0].n, 1, 'the old chat\'s leg still belongs to them');
  const n = await harness.query('SELECT COUNT(*)::int AS n FROM driver_people');
  assert.equal(n.rows[0].n, 1);
});

test('two ACTIVE drivers with the same name stay two people', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { resolver } = bind(harness);
  const one = await seedGroup(harness, { telegramId: -301, name: 'WENZE UNIT # 310 OMAR ALAWAD', first: 'OMAR', last: 'ALAWAD', unit: '310' });
  const two = await seedGroup(harness, { telegramId: -302, name: 'WENZE UNIT # 005 OMAR ALAWAD', first: 'OMAR', last: 'ALAWAD', unit: '005' });
  const p1 = (await resolver.ensurePersonForGroup(one.group)).personId;
  const r2 = await resolver.ensurePersonForGroup(two.group);
  assert.equal(r2.action, 'create', 'a namesake on an active chat is not a returning driver');
  assert.notEqual(r2.personId, p1);
});

test('a Telegram id that proves two chats are one person reconciles them, reversibly', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { resolver } = bind(harness);
  const known = await seedGroup(harness, { telegramId: -401, name: 'WENZE UNIT # 27 RUSLAN ABDULLAEV', first: 'RUSLAN', last: 'ABDULLAEV', unit: '27', telegramUserId: 8606595680 });
  const anchor = (await resolver.ensurePersonForGroup(known.group)).personId;
  // A second chat, a different spelling, no id yet → its own person.
  const other = await seedGroup(harness, { telegramId: -402, name: 'WENZE UNIT # 28 R. ABDULLAYEV', first: 'R.', last: 'ABDULLAYEV', unit: '28' });
  const lone = (await resolver.ensurePersonForGroup(other.group)).personId;
  assert.notEqual(lone, anchor);
  await harness.query(
    `INSERT INTO home_time_requests (group_id, person_id, requested_at) VALUES ($1, $2, NOW())`, [other.group.id, lone]
  );
  // Both people hold a truck before the reconcile — the anchor 27, the lone
  // person 28. The lone person's truck must not stay held by a merged row.
  await resolver.syncUnitForPerson(anchor, '27');
  await resolver.syncUnitForPerson(lone, '28');

  // The admin links the same Telegram account on the second profile.
  await harness.query('UPDATE driver_profiles SET telegram_user_id = $2 WHERE group_id = $1', [other.group.id, '8606595680']);
  const profile = (await harness.query('SELECT * FROM driver_profiles WHERE group_id = $1', [other.group.id])).rows[0];
  const outcome = await resolver.onProfileSaved(profile);

  assert.equal(outcome.reconciled.movedTo, anchor);
  assert.equal(outcome.reconciled.merged, true, 'the lone person had no other chat, so it points at the anchor');
  assert.equal(await personOf(harness, other.group.id), anchor);
  const merged = await harness.query('SELECT merged_into_person_id FROM driver_people WHERE id = $1', [lone]);
  assert.equal(merged.rows[0].merged_into_person_id, anchor, 'a pointer — the row and its history stay');
  const request = await harness.query('SELECT person_id FROM home_time_requests WHERE group_id = $1', [other.group.id]);
  assert.equal(request.rows[0].person_id, anchor, 'rows stamped with the superseded person moved');
  // And the unit on the saved profile became the anchor's truck: 27 closed, 28 open.
  const units = await harness.query(
    'SELECT unit_number, ended_at IS NULL AS open FROM driver_units WHERE person_id = $1 ORDER BY started_at, id', [anchor]
  );
  assert.deepEqual(units.rows.map((r) => [r.unit_number, r.open]), [['27', false], ['28', true]]);
  const loneOpen = await harness.query('SELECT COUNT(*)::int AS n FROM driver_units WHERE person_id = $1 AND ended_at IS NULL', [lone]);
  assert.equal(loneOpen.rows[0].n, 0, 'a merged person holds no truck');
});

test('migration 0026 fills existing rows from open associations, re-applies as a no-op, and never guesses a colliding name', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: allMigrationsSql((name) => name < '0026') });
  const migration = allMigrationsSql((name) => name.startsWith('0026'));
  const { group } = await seedGroup(harness, { telegramId: -501, name: 'WENZE UNIT # 12 UNIQUE NAME', first: 'UNIQUE', last: 'NAME', unit: '12' });
  const p = await harness.query(`INSERT INTO driver_people (display_name, normalized_key) VALUES ('UNIQUE NAME', 'nameunique') RETURNING id`);
  await harness.query(`INSERT INTO driver_person_groups (person_id, group_id, association_source) VALUES ($1, $2, 'backfill')`, [p.rows[0].id, group.id]);
  await harness.query(`INSERT INTO driver_road_history (group_id, road_started_at, home_arrived_at, days_on_road, bonus_usd) VALUES ($1, NOW(), NOW(), 1, 0)`, [group.id]);
  await harness.query(`INSERT INTO mileage_bonus_progress (driver_normalized_name, driver_name, total_miles) VALUES ('UNIQUE NAME', 'Unique Name', 10)`);
  // Two people share this name: the mileage row must stay unclaimed.
  await harness.query(`INSERT INTO driver_people (display_name) VALUES ('OMAR ALAWAD'), ('OMAR ALAWAD')`);
  await harness.query(`INSERT INTO mileage_bonus_progress (driver_normalized_name, driver_name, total_miles) VALUES ('OMAR ALAWAD', 'Omar Alawad', 10)`);

  await harness.query(migration);
  await harness.query(migration); // the second boot

  const leg = await harness.query('SELECT person_id FROM driver_road_history WHERE group_id = $1', [group.id]);
  assert.equal(leg.rows[0].person_id, p.rows[0].id);
  const mileage = await harness.query('SELECT driver_normalized_name, person_id FROM mileage_bonus_progress ORDER BY 1');
  assert.deepEqual(mileage.rows, [
    { driver_normalized_name: 'OMAR ALAWAD', person_id: null },
    { driver_normalized_name: 'UNIQUE NAME', person_id: p.rows[0].id },
  ]);
});

test('the admin backfill populates the layer and stamps what already existed', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { resolver } = bind(harness);
  const a = await seedGroup(harness, { telegramId: -601, name: 'WENZE UNIT # 27 RUSLAN ABDULLAEV', first: 'RUSLAN', last: 'ABDULLAEV', unit: '27' });
  await harness.query(`INSERT INTO home_time_requests (group_id, requested_at) VALUES ($1, NOW())`, [a.group.id]);

  const dry = await resolver.runIdentityBackfill({ apply: false });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.stamped, null);
  assert.equal(dry.coverage.groupsWithoutPerson, 1);

  const applied = await resolver.runIdentityBackfill({ apply: true });
  assert.equal(applied.applied.peopleCreated, 1);
  assert.equal(applied.stamped.home_time_requests, 1);
  assert.equal(applied.coverage.groupsWithoutPerson, 0);
  assert.equal(applied.coverage.unstamped.requests, 0);
});
