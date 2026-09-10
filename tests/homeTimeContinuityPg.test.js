/**
 * Home Time follows the PERSON — against a real PostgreSQL.
 *
 *   A driver goes home on the old truck's chat; the truck changes; they go back
 *   on the road on the new chat. The home stay that began on the old chat is
 *   closed by the return observed on the new one — one driver, one cycle.
 *
 *   A road→home insert closes anything still open for that driver first, with
 *   the observed road start as its return, so a second open stay per chat can
 *   no longer come into being — which is what lets the unique index hold.
 *
 *   The index guard creates the index only when the data already obeys it, and
 *   stands down (without failing anything) while duplicates remain.
 *
 *   The sweep sees a clock restarted on a new chat and proposes carrying it;
 *   an administrator applies it and can undo it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { POOL_PATH, purgeDataLayer } = require('./helpers/purgeDataLayer');

const ALL_MIGRATIONS = allMigrationsSql();
const SERVICE_PATHS = [
  '../services/identity/personResolver', '../services/identity/personBackfillService',
  '../services/homeTimeService', '../services/roadBonusNotifierService', '../services/roadBonusPoster',
  '../services/operations/consistencyService', '../services/operations/corrections/actions',
  '../services/operations/corrections/identityActions', '../services/operations/corrections/homeTimeActions',
  '../services/operations/corrections/alertActions', '../services/operations/corrections/apply',
  '../services/operations/corrections/autoApply',
].map((p) => path.resolve(__dirname, `${p}.js`));

function bind(harness) {
  purgeDataLayer(SERVICE_PATHS);
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true,
    exports: { pool: harness.pool, query: harness.query, ping: async () => true },
  };
  try {
    const db = { pool: harness.pool, query: harness.query };
    const store = require('../database/operationalFindings');
    const ht = require('../database/homeTime');
    const resolver = require('../services/identity/personResolver');
    const homeTime = require('../services/homeTimeService');
    const apply = require('../services/operations/corrections/apply');
    const { runConsistencySweep } = require('../services/operations/consistencyService');
    resolver.resetResolverCache();
    return {
      ht, resolver, homeTime, store,
      sweep: () => runConsistencySweep({ db, store }),
      applyCorrection: (a) => apply.applyCorrection({ ...a, db }),
      revertCorrection: (a) => apply.revertCorrection({ ...a, db }),
    };
  } finally {
    delete require.cache[POOL_PATH];
    purgeDataLayer(SERVICE_PATHS);
  }
}

const telegram = { sendMessage: async () => ({}) };

async function seedGroup(harness, { telegramId, name, first, last, unit, active = true }) {
  const g = await harness.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active) VALUES ($1, $2, 'driver', $3) RETURNING *`,
    [telegramId, name, active]
  );
  await harness.query(
    `INSERT INTO driver_profiles (group_id, first_name, last_name, unit_number, driver_type) VALUES ($1, $2, $3, $4, 'company_driver')`,
    [g.rows[0].id, first, last, unit]
  );
  return g.rows[0];
}

async function harnessWith(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await harness.query("INSERT INTO admins (id, username, password_hash) VALUES (1,'admin','x') ON CONFLICT DO NOTHING");
  await harness.query(`INSERT INTO home_time_settings (id, enabled) VALUES (1, TRUE)
    ON CONFLICT (id) DO UPDATE SET enabled = TRUE`);
  return harness;
}

const ADMIN = { id: 1, username: 'admin', roleKeys: ['super_admin'], ip: null };
const iso = (day) => `2026-08-${String(day).padStart(2, '0')}T12:00:00.000Z`;

test('a home stay begun on the old chat is closed by the return observed on the new chat', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { resolver, homeTime } = bind(harness);
  const old = await seedGroup(harness, { telegramId: -49, name: 'WENZE UNIT # 320 SIROJIDDIN DAVUROV', first: 'SIROJIDDIN', last: 'DAVUROV', unit: '320' });
  await resolver.ensurePersonForGroup(old);
  // Road since the 1st, home on the 20th — a leg is recorded and a stay opens.
  await homeTime.applyStateTransition(telegram, old, { newState: 'road', eventAt: iso(1), announce: false });
  await homeTime.applyStateTransition(telegram, old, { newState: 'home', eventAt: iso(20), announce: false });
  const opened = await harness.query('SELECT id, person_id, return_to_road_at FROM driver_road_history WHERE group_id = $1', [old.id]);
  assert.equal(opened.rows.length, 1);
  assert.equal(opened.rows[0].return_to_road_at, null);
  assert.ok(opened.rows[0].person_id, 'the leg names the person');

  // The truck changed: the old chat goes inactive, a new one appears, same driver.
  await harness.query('UPDATE groups SET active = FALSE WHERE id = $1', [old.id]);
  const fresh = await seedGroup(harness, { telegramId: -541877, name: 'WENZE UNIT # 322 SIROJIDDIN DAVUROV', first: 'SIROJIDDIN', last: 'DAVUROV', unit: '322' });
  const placed = await resolver.ensurePersonForGroup(fresh);
  assert.equal(placed.action, 'link');

  // Back on the road, observed on the NEW chat.
  await homeTime.applyStateTransition(telegram, fresh, { newState: 'home', eventAt: iso(21), announce: false });
  await homeTime.applyStateTransition(telegram, fresh, { newState: 'road', eventAt: iso(24), announce: false });

  const closed = await harness.query('SELECT return_to_road_at, home_days FROM driver_road_history WHERE id = $1', [opened.rows[0].id]);
  assert.equal(new Date(closed.rows[0].return_to_road_at).toISOString(), iso(24), 'the OLD chat\'s stay is closed by the NEW chat\'s return');
  assert.equal(closed.rows[0].home_days, 4);
  const stillOpen = await harness.query('SELECT COUNT(*)::int AS n FROM driver_road_history WHERE person_id = $1 AND return_to_road_at IS NULL', [placed.personId]);
  assert.equal(stillOpen.rows[0].n, 0, 'one driver, no orphaned cycle');
});

test('a new road→home leg closes whatever was still open for the driver first, so a second open stay cannot arise', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { resolver, homeTime, ht } = bind(harness);
  const group = await seedGroup(harness, { telegramId: -1, name: 'WENZE UNIT # 27 RUSLAN ABDULLAEV', first: 'RUSLAN', last: 'ABDULLAEV', unit: '27' });
  await resolver.ensurePersonForGroup(group);
  // The production shape: a stay left open (by a path that once bypassed the
  // close), and the flip-flop already back on the road.
  await harness.query(
    `INSERT INTO driver_road_history (group_id, road_started_at, home_arrived_at, days_on_road, bonus_usd)
     VALUES ($1, $2, $3, 9, 0)`, [group.id, iso(1), iso(10)]
  );
  await harness.query(
    `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at) VALUES ($1, 'road', $2, $2)`,
    [group.id, iso(12)]
  );

  const guardBefore = await ht.ensureOpenStayIndex();
  assert.equal(guardBefore.status, 'created', 'one open row per group is not a duplicate; the index goes in');

  await homeTime.applyStateTransition(telegram, group, { newState: 'home', eventAt: iso(30), announce: false });

  const rows = await harness.query('SELECT road_started_at, home_arrived_at, return_to_road_at FROM driver_road_history WHERE group_id = $1 ORDER BY id', [group.id]);
  assert.equal(rows.rows.length, 2, 'the new leg was recorded — the index did not refuse it');
  assert.equal(new Date(rows.rows[0].return_to_road_at).toISOString(), iso(12),
    'the lingering stay was closed with the observed road start (class-B evidence)');
  assert.equal(rows.rows[1].return_to_road_at, null, 'the new stay is the one open row');

  await assert.rejects(
    harness.query(`INSERT INTO driver_road_history (group_id, road_started_at, home_arrived_at, days_on_road, bonus_usd)
                   VALUES ($1, $2, $3, 1, 0)`, [group.id, iso(30), iso(31)]),
    /uniq_driver_road_history_open_stay/,
    'the database now refuses a second open stay for the group'
  );
});

test('the index guard stands down while duplicates remain, creates the index once they are gone, and never throws', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { ht } = bind(harness);
  const group = await seedGroup(harness, { telegramId: -1, name: 'WENZE UNIT # 1 DUP', first: 'D', last: 'UP', unit: '1' });
  for (const day of [1, 5]) {
    await harness.query(
      `INSERT INTO driver_road_history (group_id, road_started_at, home_arrived_at, days_on_road, bonus_usd) VALUES ($1, $2, $3, 1, 0)`,
      [group.id, iso(day), iso(day + 1)]
    );
  }
  const blocked = await ht.ensureOpenStayIndex();
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.duplicates, 1);
  assert.deepEqual(blocked.groups, [group.id]);
  assert.equal((await harness.query("SELECT 1 FROM pg_indexes WHERE indexname = 'uniq_driver_road_history_open_stay'")).rows.length, 0);

  await harness.query('UPDATE driver_road_history SET return_to_road_at = $2 WHERE group_id = $1 AND home_arrived_at = $3', [group.id, iso(5), iso(2)]);
  assert.equal((await ht.ensureOpenStayIndex()).status, 'created');
  assert.equal((await ht.ensureOpenStayIndex()).status, 'present', 'the next boot finds it and does nothing');
});

test('the sweep proposes carrying a clock restarted on a new chat; an administrator applies and reverts it', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { resolver, sweep, applyCorrection, revertCorrection, store } = bind(harness);
  const old = await seedGroup(harness, { telegramId: -49, name: 'WENZE UNIT # 27 RUSLAN ABDULLAEV', first: 'RUSLAN', last: 'ABDULLAEV', unit: '27' });
  await resolver.ensurePersonForGroup(old);
  await harness.query(
    `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at, road_bonus_weeks_notified)
     VALUES ($1, 'road', $2, $3, 1)`, [old.id, iso(3), iso(31)]
  );
  await harness.query('UPDATE groups SET active = FALSE WHERE id = $1', [old.id]);
  const fresh = await seedGroup(harness, { telegramId: -541877, name: 'WENZE UNIT # 27 RUSLAN ABDULLAEV', first: 'RUSLAN', last: 'ABDULLAEV', unit: '27' });
  await resolver.ensurePersonForGroup(fresh);
  await harness.query(
    `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at, road_bonus_weeks_notified)
     VALUES ($1, 'road', NOW(), NOW(), 0)`, [fresh.id]
  );

  const { findings } = await sweep();
  const finding = findings.find((f) => f.checkKey === 'home_time.clock_reset_on_group_change');
  assert.ok(finding, 'the restarted clock is noticed');
  assert.equal(finding.subjectId, fresh.id);
  assert.equal(finding.tier, 'approval');
  const filed = (await store.listFindings({ status: 'open', checkKey: 'home_time.clock_reset_on_group_change' }))[0];

  await assert.rejects(
    applyCorrection({ finding: filed, actionKey: 'home_time.carry_road_clock', payload: {
      groupId: fresh.id, fromStateSince: finding.proposedChange.from, toStateSince: finding.proposedChange.to,
      fromGroupId: old.id, personId: finding.proposedChange.personId, roadBonusWeeksNotified: 1,
    }, admin: null }),
    /cannot be applied by the system/, 'an approval is never applied by the system'
  );

  const correction = await applyCorrection({
    finding: filed, actionKey: 'home_time.carry_road_clock', payload: {
      groupId: fresh.id, fromStateSince: finding.proposedChange.from, toStateSince: finding.proposedChange.to,
      fromGroupId: old.id, personId: finding.proposedChange.personId, roadBonusWeeksNotified: 1,
    }, admin: ADMIN, reason: 'same driver, truck changed',
  });
  let status = await harness.query('SELECT state_since, road_bonus_weeks_notified FROM driver_home_status WHERE group_id = $1', [fresh.id]);
  assert.equal(new Date(status.rows[0].state_since).toISOString(), iso(3), 'the clock is the OLD chat\'s, copied');
  assert.equal(status.rows[0].road_bonus_weeks_notified, 1, 'announced weeks travel with it');

  await revertCorrection({ correctionId: correction.id, admin: ADMIN, reason: 'undo' });
  status = await harness.query('SELECT state_since, road_bonus_weeks_notified FROM driver_home_status WHERE group_id = $1', [fresh.id]);
  assert.equal(new Date(status.rows[0].state_since).toISOString(), new Date(finding.proposedChange.from).toISOString());
  assert.equal(status.rows[0].road_bonus_weeks_notified, 0);
});

test('carrying a clock is refused once either chat belongs to a different person than the finding saw', { skip: skipWithoutPg() }, async (t) => {
  const harness = await harnessWith(t);
  const { resolver, sweep, applyCorrection, store } = bind(harness);
  const old = await seedGroup(harness, { telegramId: -49, name: 'WENZE UNIT # 27 RUSLAN ABDULLAEV', first: 'RUSLAN', last: 'ABDULLAEV', unit: '27' });
  const personId = (await resolver.ensurePersonForGroup(old)).personId;
  await harness.query(`INSERT INTO driver_home_status (group_id, state, state_since, last_status_at) VALUES ($1, 'road', $2, $3)`, [old.id, iso(3), iso(31)]);
  await harness.query('UPDATE groups SET active = FALSE WHERE id = $1', [old.id]);
  const fresh = await seedGroup(harness, { telegramId: -541877, name: 'WENZE UNIT # 27 RUSLAN ABDULLAEV', first: 'RUSLAN', last: 'ABDULLAEV', unit: '27' });
  await resolver.ensurePersonForGroup(fresh);
  await harness.query(`INSERT INTO driver_home_status (group_id, state, state_since, last_status_at) VALUES ($1, 'road', NOW(), NOW())`, [fresh.id]);
  const { findings } = await sweep();
  const finding = findings.find((f) => f.checkKey === 'home_time.clock_reset_on_group_change');
  const filed = (await store.listFindings({ status: 'open', checkKey: 'home_time.clock_reset_on_group_change' }))[0];

  // Between the sweep and the click, an administrator re-links the new chat to
  // somebody else. The clocks have not moved — the identity evidence has.
  const other = await harness.query(`INSERT INTO driver_people (display_name) VALUES ('SOMEBODY ELSE') RETURNING id`);
  await harness.query('UPDATE driver_person_groups SET ended_at = NOW() WHERE group_id = $1 AND ended_at IS NULL', [fresh.id]);
  await harness.query(`INSERT INTO driver_person_groups (person_id, group_id, association_source) VALUES ($1, $2, 'manual')`, [other.rows[0].id, fresh.id]);

  await assert.rejects(
    applyCorrection({ finding: filed, actionKey: 'home_time.carry_road_clock', payload: {
      groupId: fresh.id, fromStateSince: finding.proposedChange.from, toStateSince: finding.proposedChange.to,
      fromGroupId: old.id, personId, roadBonusWeeksNotified: 0,
    }, admin: ADMIN }),
    (err) => err.stale === true || err.name === 'StaleCorrectionError',
    'another driver\'s road start must not land on this chat'
  );
  const status = await harness.query('SELECT state_since FROM driver_home_status WHERE group_id = $1', [fresh.id]);
  assert.notEqual(new Date(status.rows[0].state_since).toISOString(), iso(3));
});
