'use strict';

/**
 * Migration 0047 against the real schema.
 *
 * This migration contains the one destructive step in the whole programme —
 * dropping `uniq_driver_units_open_unit` — so the tests that matter are the ones
 * about what happens when the swap is NOT safe. A migration that quietly took
 * the fleet's uniqueness guarantee away on a bad assumption would be very hard
 * to notice and very expensive to undo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { createPgHarness, skipWithoutPg } = require('./helpers/pgHarness');

// `h.query` rather than `h.applySchemaSql`: the latter takes no argument and
// re-applies the BASELINE, so passing a migration to it silently applies
// nothing — which is how the first draft of this file "passed" without ever
// running the migration under test.

const MIGRATIONS_DIR = path.join(__dirname, '..', 'database', 'migrations');

/** Every migration BEFORE 0047 — the state this one has to upgrade from. */
function migrationsBefore47() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) < 47)
    .sort()
    .map((f) => fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n;\n');
}

const MIGRATION_47 = fs.readFileSync(
  path.join(MIGRATIONS_DIR, '0047_fleet_type_first_class.sql'), 'utf8'
);

async function setupBefore47(t) {
  return createPgHarness(t, { extraDdl: migrationsBefore47() });
}

async function seedPersonWithUnit(h, { name, unit, seat = null, endedAt = null }) {
  const p = await h.query(
    `INSERT INTO driver_people (display_name, normalized_key) VALUES ($1, $2) RETURNING id`,
    [name, name.toLowerCase().replace(/\s+/g, '')]
  );
  const personId = p.rows[0].id;
  const cols = ['person_id', 'unit_number', 'source'];
  const vals = [personId, unit, 'backfill'];
  if (seat !== null) { cols.push('seat'); vals.push(seat); }
  if (endedAt !== null) { cols.push('ended_at'); vals.push(endedAt); }
  const params = vals.map((_, i) => `$${i + 1}`).join(', ');
  await h.query(
    `INSERT INTO driver_units (${cols.join(', ')}) VALUES (${params})`, vals
  );
  return personId;
}

test('the old index is replaced by the fleet-aware one', { skip: skipWithoutPg() }, async (t) => {
  const h = await setupBefore47(t);
  const before = await h.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'driver_units'`
  );
  assert.ok(before.rows.some((r) => r.indexname === 'uniq_driver_units_open_unit'),
    'the state this migration upgrades from');

  await h.query(MIGRATION_47);

  const after = await h.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'driver_units'`
  );
  const names = after.rows.map((r) => r.indexname);
  assert.ok(names.includes('uniq_driver_units_open_fleet_unit_seat'));
  assert.ok(!names.includes('uniq_driver_units_open_unit'), 'the weaker name is gone');
  assert.ok(names.includes('uniq_driver_units_open_person'),
    'a person still drives one truck at a time');
});

test('running it twice changes nothing', { skip: skipWithoutPg() }, async (t) => {
  const h = await setupBefore47(t);
  await h.query(MIGRATION_47);
  await h.query(MIGRATION_47);
  const after = await h.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'driver_units' ORDER BY indexname`
  );
  assert.deepEqual(
    after.rows.map((r) => r.indexname).filter((n) => n.startsWith('uniq')),
    ['uniq_driver_units_open_fleet_unit_seat', 'uniq_driver_units_open_person']
  );
});

test('Company 001 and Owner-Operator 001 are two trucks', { skip: skipWithoutPg() }, async (t) => {
  const h = await setupBefore47(t);
  await h.query(MIGRATION_47);

  const a = await seedPersonWithUnit(h, { name: 'A ONE', unit: '001' });
  await h.query(`UPDATE driver_units SET fleet_type = 'company' WHERE person_id = $1`, [a]);
  const b = await seedPersonWithUnit(h, { name: 'B TWO', unit: '001' });
  await h.query(`UPDATE driver_units SET fleet_type = 'owner_operator' WHERE person_id = $1`, [b]);

  const n = await h.query(`SELECT COUNT(*)::int AS n FROM driver_units WHERE unit_number = '001'`);
  assert.equal(n.rows[0].n, 2, 'the old index made this unrepresentable');
});

test('a team takes seat 2; a third person on that truck is refused', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setupBefore47(t);
  await h.query(MIGRATION_47);

  const first = await seedPersonWithUnit(h, { name: 'A ONE', unit: '008' });
  await h.query(`UPDATE driver_units SET fleet_type = 'company' WHERE person_id = $1`, [first]);

  // Seat 1 is taken; a second person in seat 1 of the same company truck is not
  // a team, it is two drivers claiming one seat.
  const second = await h.query(
    `INSERT INTO driver_people (display_name, normalized_key) VALUES ('B TWO', 'btwo') RETURNING id`
  );
  await assert.rejects(
    () => h.query(
      `INSERT INTO driver_units (person_id, unit_number, source, fleet_type, seat)
       VALUES ($1, '008', 'backfill', 'company', 1)`,
      [second.rows[0].id]
    ),
    /uniq_driver_units_open_fleet_unit_seat|duplicate key/
  );

  // Seat 2 is the team's other half, and it is accepted.
  await h.query(
    `INSERT INTO driver_units (person_id, unit_number, source, fleet_type, seat)
     VALUES ($1, '008', 'backfill', 'company', 2)`,
    [second.rows[0].id]
  );

  const third = await h.query(
    `INSERT INTO driver_people (display_name, normalized_key) VALUES ('C THREE', 'cthree') RETURNING id`
  );
  await assert.rejects(
    () => h.query(
      `INSERT INTO driver_units (person_id, unit_number, source, fleet_type, seat)
       VALUES ($1, '008', 'backfill', 'company', 2)`,
      [third.rows[0].id]
    ),
    /uniq_driver_units_open_fleet_unit_seat|duplicate key/,
    'a truck has two seats, not three'
  );
});

test('the seat CHECK refuses a third seat outright', { skip: skipWithoutPg() }, async (t) => {
  const h = await setupBefore47(t);
  await h.query(MIGRATION_47);
  const p = await h.query(
    `INSERT INTO driver_people (display_name, normalized_key) VALUES ('D FOUR', 'dfour') RETURNING id`
  );
  await assert.rejects(
    () => h.query(
      `INSERT INTO driver_units (person_id, unit_number, source, seat)
       VALUES ($1, '009', 'backfill', 3)`, [p.rows[0].id]
    ),
    /driver_units_seat_check/
  );
});

test('fleet type is backfilled from a recorded driver_type, and never guessed', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setupBefore47(t);

  const g = await h.query(
    `INSERT INTO groups (group_name, telegram_group_id, group_type, active)
     VALUES ('WENZE UNIT # 700 A ONE (LEASE DRIVERS)', -1007001, 'driver', TRUE) RETURNING id`
  );
  const groupId = g.rows[0].id;
  const personId = await seedPersonWithUnit(h, { name: 'A ONE', unit: '700' });
  await h.query(
    `INSERT INTO driver_person_groups (person_id, group_id, association_source, confidence)
     VALUES ($1, $2, 'backfill', 100)`, [personId, groupId]
  );
  // driver_type is NOT set: the title says LEASE, but nobody has decided.
  await h.query(
    `INSERT INTO driver_profiles (group_id, first_name, unit_number) VALUES ($1, 'A', '700')`,
    [groupId]
  );

  await h.query(MIGRATION_47);

  const unknown = await h.query(
    `SELECT fleet_type FROM driver_units WHERE person_id = $1`, [personId]
  );
  assert.equal(unknown.rows[0].fleet_type, 'unknown',
    'the backfill parses no titles — a guess baked into this column decides who shares a truck');
});

test('a recorded driver_type IS carried across, including the new lease', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setupBefore47(t);
  const seeded = [];
  for (const [i, type] of [['company_driver'], ['owner']].flat().entries()) {
    const g = await h.query(
      `INSERT INTO groups (group_name, telegram_group_id, group_type, active)
       VALUES ($1, $2, 'driver', TRUE) RETURNING id`,
      [`WENZE UNIT # 80${i} DRIVER ${i}`, -100800 - i]
    );
    const groupId = g.rows[0].id;
    const personId = await seedPersonWithUnit(h, { name: `P${i}`, unit: `80${i}` });
    await h.query(
      `INSERT INTO driver_person_groups (person_id, group_id, association_source, confidence)
       VALUES ($1, $2, 'backfill', 100)`, [personId, groupId]
    );
    await h.query(
      `INSERT INTO driver_profiles (group_id, first_name, driver_type) VALUES ($1, $2, $3)`,
      [groupId, `P${i}`, type]
    );
    seeded.push({ personId, type });
  }

  await h.query(MIGRATION_47);

  const expected = { company_driver: 'company', owner: 'owner_operator' };
  for (const { personId, type } of seeded) {
    const r = await h.query(`SELECT fleet_type FROM driver_units WHERE person_id = $1`, [personId]);
    assert.equal(r.rows[0].fleet_type, expected[type], type);
  }

  // And `lease` is now a value the column accepts at all.
  const g = await h.query(
    `INSERT INTO groups (group_name, telegram_group_id, group_type, active)
     VALUES ('WENZE UNIT # 900 L', -100900, 'driver', TRUE) RETURNING id`
  );
  await h.query(
    `INSERT INTO driver_profiles (group_id, first_name, driver_type) VALUES ($1, 'L', 'lease')`,
    [g.rows[0].id]
  );
});

test('a person whose two open chats DISAGREE is left unknown, not coin-tossed', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setupBefore47(t);

  // One person, two OPEN associations — `identity.person_on_two_active_groups`,
  // a condition production actually has — whose profiles disagree. A plain
  // `UPDATE ... FROM` matches both and Postgres picks one arbitrarily: a coin
  // toss, silently, into the column that decides who may share a truck number.
  const p = await h.query(
    `INSERT INTO driver_people (display_name, normalized_key) VALUES ('A ONE','aone') RETURNING id`
  );
  const personId = p.rows[0].id;
  for (const [i, type] of ['company_driver', 'owner'].entries()) {
    const g = await h.query(
      `INSERT INTO groups (group_name, telegram_group_id, group_type, active)
       VALUES ($1, $2, 'driver', TRUE) RETURNING id`,
      [`CHAT ${i}`, -3100 - i]
    );
    await h.query(
      `INSERT INTO driver_person_groups (person_id, group_id, association_source, confidence)
       VALUES ($1, $2, 'backfill', 100)`, [personId, g.rows[0].id]
    );
    await h.query(
      `INSERT INTO driver_profiles (group_id, first_name, driver_type) VALUES ($1, 'A', $2)`,
      [g.rows[0].id, type]
    );
  }
  await h.query(
    `INSERT INTO driver_units (person_id, unit_number, source) VALUES ($1, '001', 'backfill')`,
    [personId]
  );

  await h.query(MIGRATION_47);

  const row = await h.query(`SELECT fleet_type FROM driver_units WHERE person_id = $1`, [personId]);
  assert.equal(row.rows[0].fleet_type, 'unknown',
    'a disagreement is a question for a person, not a coin toss');
});

test('a person whose two open chats AGREE is still backfilled', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setupBefore47(t);
  const p = await h.query(
    `INSERT INTO driver_people (display_name, normalized_key) VALUES ('B TWO','btwo') RETURNING id`
  );
  const personId = p.rows[0].id;
  for (const i of [0, 1]) {
    const g = await h.query(
      `INSERT INTO groups (group_name, telegram_group_id, group_type, active)
       VALUES ($1, $2, 'driver', TRUE) RETURNING id`, [`CHAT ${i}`, -3200 - i]
    );
    await h.query(
      `INSERT INTO driver_person_groups (person_id, group_id, association_source, confidence)
       VALUES ($1, $2, 'backfill', 100)`, [personId, g.rows[0].id]
    );
    await h.query(
      `INSERT INTO driver_profiles (group_id, first_name, driver_type)
       VALUES ($1, 'B', 'company_driver')`, [g.rows[0].id]
    );
  }
  await h.query(
    `INSERT INTO driver_units (person_id, unit_number, source) VALUES ($1, '002', 'backfill')`,
    [personId]
  );

  await h.query(MIGRATION_47);

  const row = await h.query(`SELECT fleet_type FROM driver_units WHERE person_id = $1`, [personId]);
  assert.equal(row.rows[0].fleet_type, 'company', 'agreement is not ambiguity');
});

test('a collision leaves the old index in force and files a serious finding', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setupBefore47(t);

  // Two OPEN rows on one unit. The old index forbids this, so it is created by
  // dropping the index first — which is exactly the hand-edit the DO block
  // exists to survive.
  await h.query('DROP INDEX IF EXISTS uniq_driver_units_open_unit');
  await h.query('DROP INDEX IF EXISTS uniq_driver_units_open_person');
  await seedPersonWithUnit(h, { name: 'A ONE', unit: '001' });
  await seedPersonWithUnit(h, { name: 'B TWO', unit: '001' });
  await h.query(
    `CREATE UNIQUE INDEX uniq_driver_units_open_unit
       ON driver_units (unit_number) WHERE ended_at IS NULL AND FALSE`
  );

  await h.query(MIGRATION_47);

  const names = (await h.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'driver_units'`
  )).rows.map((r) => r.indexname);
  assert.ok(!names.includes('uniq_driver_units_open_fleet_unit_seat'),
    'the swap must not happen while the rows would violate it');
  assert.ok(names.includes('uniq_driver_units_open_unit'),
    'and the old guarantee stays until a person resolves the collisions');

  const finding = await h.query(
    `SELECT severity, tier, evidence_json FROM operational_findings
      WHERE check_key = 'identity.unit_index_migration_blocked'`
  );
  assert.equal(finding.rows.length, 1, 'somebody has to be told');
  assert.equal(finding.rows[0].severity, 'serious');
  assert.equal(finding.rows[0].evidence_json.collisions, 1);
});

test('a CLOSED row never collides with an open one', { skip: skipWithoutPg() }, async (t) => {
  const h = await setupBefore47(t);
  await h.query(MIGRATION_47);
  const a = await seedPersonWithUnit(h, { name: 'A ONE', unit: '310' });
  await h.query(`UPDATE driver_units SET ended_at = NOW(), fleet_type = 'company' WHERE person_id = $1`, [a]);
  const b = await seedPersonWithUnit(h, { name: 'B TWO', unit: '310' });
  await h.query(`UPDATE driver_units SET fleet_type = 'company' WHERE person_id = $1`, [b]);
  const n = await h.query(
    `SELECT COUNT(*)::int AS n FROM driver_units WHERE unit_number = '310'`
  );
  assert.equal(n.rows[0].n, 2, 'history is not a conflict — that is what ended_at is for');
});

test('the driver_type CHECK accepts lease and still refuses nonsense', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await setupBefore47(t);
  await h.query(MIGRATION_47);
  const g = await h.query(
    `INSERT INTO groups (group_name, telegram_group_id, group_type, active)
     VALUES ('W UNIT # 1 X', -1000001, 'driver', TRUE) RETURNING id`
  );
  await assert.rejects(
    () => h.query(
      `INSERT INTO driver_profiles (group_id, first_name, driver_type) VALUES ($1, 'X', 'contractor')`,
      [g.rows[0].id]
    ),
    /driver_profiles_driver_type_check/
  );
});

// ── the person layer, against the migrated schema ────────────────────────────

async function setupAfter47(t) {
  const { allMigrationsSql } = require('./helpers/pgHarness');
  const h = await createPgHarness(t, { extraDdl: allMigrationsSql() });
  return { h, people: h.loadDataLayer(['driverPeople']).driverPeople };
}

test('an assignment records its fleet and seat, defaulting to the honest answers', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, people } = await setupAfter47(t);
  const p = await h.query(
    `INSERT INTO driver_people (display_name, normalized_key) VALUES ('A ONE','aone') RETURNING id`
  );
  const personId = p.rows[0].id;

  const bare = await people.openUnitAssignment({ personId, unitNumber: '500' });
  assert.equal(bare.fleetType, 'unknown', 'a caller that did not say must not have a fleet invented');
  assert.equal(bare.seat, 1);

  await people.closeUnitAssignment({ personId });
  const typed = await people.openUnitAssignment({
    personId, unitNumber: '500', fleetType: 'lease', seat: 2,
  });
  assert.equal(typed.fleetType, 'lease');
  assert.equal(typed.seat, 2);
});

test('a fleet nobody recognises is stored as unknown, not as itself', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, people } = await setupAfter47(t);
  const p = await h.query(
    `INSERT INTO driver_people (display_name, normalized_key) VALUES ('B TWO','btwo') RETURNING id`
  );
  // The CHECK would refuse 'contractor' outright; the guard turns a bad value
  // into the honest one instead of a failed write in the middle of a sync.
  const row = await people.openUnitAssignment({
    personId: p.rows[0].id, unitNumber: '501', fleetType: 'contractor',
  });
  assert.equal(row.fleetType, 'unknown');
});

test('the holders lookup returns EVERY holder of a number, in every fleet', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { h, people } = await setupAfter47(t);
  const ids = [];
  for (const [name, fleet, seat] of [
    ['A ONE', 'company', 1], ['B TWO', 'company', 2], ['C THREE', 'owner_operator', 1],
  ]) {
    const p = await h.query(
      `INSERT INTO driver_people (display_name, normalized_key) VALUES ($1,$2) RETURNING id`,
      [name, name.toLowerCase().replace(/\s+/g, '')]
    );
    ids.push(p.rows[0].id);
    await people.openUnitAssignment({
      personId: p.rows[0].id, unitNumber: '001', fleetType: fleet, seat,
    });
  }

  const holders = await people.getOpenHoldersForUnit('001');
  assert.equal(holders.length, 3,
    'a number is not a truck — the decision needs every holder, not the first row');
  assert.deepEqual(holders.map((x) => x.fleetType).sort(),
    ['company', 'company', 'owner_operator']);
  assert.deepEqual(holders.map((x) => x.seat), [1, 1, 2].sort((a, b) => a - b));

  // A closed assignment is history, not a holder.
  await people.closeUnitAssignment({ personId: ids[0] });
  assert.equal((await people.getOpenHoldersForUnit('001')).length, 2);
  assert.deepEqual(await people.getOpenHoldersForUnit('  '), []);
});
