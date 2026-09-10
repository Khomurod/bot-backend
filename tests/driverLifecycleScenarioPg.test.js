/**
 * One driver's life across every system — end to end, against a real PostgreSQL.
 *
 * This is the scenario the Phase 3 brief asked to be proven rather than
 * described: a driver is seen, goes on the road, comes home, changes truck (and
 * therefore chat), goes back out; their old truck gets a new driver; Raise finds
 * them by a truck they no longer drive; the watchdog places a quiet driver by
 * itself once allowed; and a restart changes nothing. Every step goes through
 * the real modules bound to a throwaway database — no stubs below the service
 * layer.
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
  '../services/driverGroupDirectoryService', '../services/raise/teamRoster',
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
    const profiles = require('../database/driverProfiles');
    const resolver = require('../services/identity/personResolver');
    const homeTime = require('../services/homeTimeService');
    const roster = require('../services/raise/teamRoster');
    const autoApply = require('../services/operations/corrections/autoApply');
    const { runConsistencySweep } = require('../services/operations/consistencyService');
    resolver.resetResolverCache();
    // What index.js wires at boot.
    profiles.setProfileSavedHook(resolver.onProfileSaved);
    return {
      ht, profiles, resolver, homeTime, roster, store,
      sweep: () => runConsistencySweep({ db, store }),
      autoApply: (o = {}) => autoApply.runAutoCorrections({ ...o, db, store }),
    };
  } finally {
    delete require.cache[POOL_PATH];
    purgeDataLayer(SERVICE_PATHS);
  }
}

const telegram = { sendMessage: async () => ({}) };
const iso = (day) => `2026-08-${String(day).padStart(2, '0')}T12:00:00.000Z`;
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** A chat appears and, as the admin would, its profile is filled in. */
async function driverGroupAppears(harness, bound, { telegramId, name, first, last, unit }) {
  const g = await harness.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active) VALUES ($1, $2, 'driver', TRUE) RETURNING *`,
    [telegramId, name]
  );
  const group = g.rows[0];
  // The bot's capture middleware places the group...
  const placed = await bound.resolver.ensurePersonForGroup(group, { force: true });
  // ...and the profile save keeps the truck true (the hook is detached).
  await bound.profiles.upsertDriverProfileByGroupId({
    group_id: group.id, first_name: first, last_name: last, unit_number: unit, driver_type: 'company_driver', status: 'active',
  });
  await settle();
  return { group, placed };
}

test('a driver is seen, works, comes home, changes truck, goes back out — one person, one history, one cycle', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await harness.query("INSERT INTO admins (id, username, password_hash) VALUES (1,'admin','x') ON CONFLICT DO NOTHING");
  await harness.query(`INSERT INTO home_time_settings (id, enabled) VALUES (1, TRUE) ON CONFLICT (id) DO UPDATE SET enabled = TRUE`);
  const bound = bind(harness);
  const { resolver, homeTime, roster, ht } = bound;

  // ── 1. Seen for the first time ─────────────────────────────────────────────
  const a = await driverGroupAppears(harness, bound, { telegramId: -49, name: 'WENZE UNIT # 320 RUSLAN ABDULLAEV', first: 'RUSLAN', last: 'ABDULLAEV', unit: '320' });
  assert.equal(a.placed.action, 'create');
  const personId = a.placed.personId;
  let unit = await harness.query('SELECT unit_number FROM driver_units WHERE person_id = $1 AND ended_at IS NULL', [personId]);
  assert.equal(unit.rows[0].unit_number, '320', 'the profile save recorded the truck');

  // ── 2. On the road, then home ──────────────────────────────────────────────
  await homeTime.applyStateTransition(telegram, a.group, { newState: 'road', eventAt: iso(1), announce: false });
  await homeTime.applyStateTransition(telegram, a.group, { newState: 'home', eventAt: iso(20), announce: false });
  const legs = await harness.query('SELECT person_id, return_to_road_at FROM driver_road_history WHERE group_id = $1', [a.group.id]);
  assert.equal(legs.rows.length, 1);
  assert.equal(legs.rows[0].person_id, personId, 'the leg is stamped with the person at write time');

  // ── 3. Truck change: old chat retired, new chat created, same name ─────────
  await harness.query('UPDATE groups SET active = FALSE WHERE id = $1', [a.group.id]);
  const b = await driverGroupAppears(harness, bound, { telegramId: -541877, name: 'WENZE UNIT # 322 RUSLAN ABDULLAEV', first: 'RUSLAN', last: 'ABDULLAEV', unit: '322' });
  assert.equal(b.placed.action, 'link', 'a returning name whose other chat went inactive is the SAME person');
  assert.equal(b.placed.personId, personId);
  const units = await harness.query('SELECT unit_number, ended_at IS NULL AS open FROM driver_units WHERE person_id = $1 ORDER BY started_at, id', [personId]);
  assert.deepEqual(units.rows.map((r) => [r.unit_number, r.open]), [['320', false], ['322', true]], 'a change of truck, not a second driver');
  const people = await harness.query('SELECT COUNT(*)::int AS n FROM driver_people');
  assert.equal(people.rows[0].n, 1);

  // ── 4. Home Time continues on the new chat ─────────────────────────────────
  await homeTime.applyStateTransition(telegram, b.group, { newState: 'home', eventAt: iso(21), announce: false });
  await homeTime.applyStateTransition(telegram, b.group, { newState: 'road', eventAt: iso(24), announce: false });
  const oldStay = await harness.query('SELECT return_to_road_at, home_days FROM driver_road_history WHERE group_id = $1', [a.group.id]);
  assert.equal(new Date(oldStay.rows[0].return_to_road_at).toISOString(), iso(24), 'the stay begun on the old chat closed on the new one');
  assert.equal(oldStay.rows[0].home_days, 4);
  const history = await ht.listRoadHistory({ limit: 10 });
  assert.equal(history[0].current_group_id, b.group.id, 'the admin sees the leg under the CURRENT chat');
  assert.equal(history[0].group_id, a.group.id, 'and still knows where it was recorded');

  // ── 5. The old truck gets a new driver ─────────────────────────────────────
  const c = await driverGroupAppears(harness, bound, { telegramId: -77, name: 'WENZE UNIT # 320 STARKS DAYMON', first: 'STARKS', last: 'DAYMON', unit: '320' });
  assert.equal(c.placed.action, 'create', 'a different name is a different person');
  unit = await harness.query('SELECT person_id FROM driver_units WHERE unit_number = $1 AND ended_at IS NULL', ['320']);
  assert.equal(unit.rows[0].person_id, c.placed.personId, '320 was free — its previous driver moved to 322 — so the new driver holds it');

  // A fourth chat claiming 322, which RUSLAN still holds, is refused — not evicted.
  const d = await driverGroupAppears(harness, bound, { telegramId: -78, name: 'WENZE UNIT # 322 OLABODE OLUDAISI', first: 'OLABODE', last: 'OLUDAISI', unit: '322' });
  unit = await harness.query('SELECT person_id FROM driver_units WHERE unit_number = $1 AND ended_at IS NULL', ['322']);
  assert.equal(unit.rows[0].person_id, personId, 'a chat title does not evict the recorded driver');
  const { findings } = await bound.sweep();
  assert.ok(findings.some((f) => f.checkKey === 'identity.unit_contested' && f.subjectId === d.group.id), 'the contest is a finding for a person');

  // ── 6. Raise finds the driver by a truck they no longer drive ──────────────
  const found = await roster.listAssignableDrivers({ companyOnly: true, includeInactive: false, search: '320' });
  const names = found.map((r) => r.driver_name).sort();
  assert.deepEqual(names, ['RUSLAN ABDULLAEV', 'STARKS DAYMON'], 'the current holder AND the driver who moved on');
  const ruslan = found.find((r) => r.driver_name === 'RUSLAN ABDULLAEV');
  assert.equal(ruslan.person_id, personId);
  assert.equal(ruslan.unit_number, '322');
  assert.equal(ruslan.person_unit_history, '320 322');

  // ── 7. A quiet driver is placed by the watchdog once allowed ───────────────
  const quiet = await harness.query(
    `INSERT INTO groups (telegram_group_id, group_name, group_type, active) VALUES (-99, 'WENZE UNIT # 12 QUIET DRIVER', 'driver', TRUE) RETURNING id`
  );
  await harness.query(`INSERT INTO driver_profiles (group_id, first_name, last_name, unit_number) VALUES ($1, 'QUIET', 'DRIVER', '12')`, [quiet.rows[0].id]);
  await bound.sweep();
  let auto = await bound.autoApply({ apply: true });
  assert.equal(auto.summary.applied, 0, 'every check ships disabled');
  await harness.query(`INSERT INTO operational_check_settings (check_key, auto_apply_enabled, max_auto_per_run) VALUES ('identity.group_without_person', TRUE, 50)`);
  auto = await bound.autoApply({ apply: true });
  assert.equal(auto.summary.applied, 1);
  const quietPerson = await harness.query('SELECT person_id FROM driver_person_groups WHERE group_id = $1 AND ended_at IS NULL', [quiet.rows[0].id]);
  assert.ok(quietPerson.rows[0]?.person_id, 'placed with no message and no person');
  const audit = await harness.query(`SELECT COUNT(*)::int AS n FROM admin_audit_log`);
  assert.ok(audit.rows[0].n >= 1, 'and the audit log says so');

  // ── 8. Restart: nothing is lost, nothing is repeated ───────────────────────
  assert.equal((await ht.ensureOpenStayIndex()).status, 'created', 'boot creates the index once the data obeys it');
  await harness.query(ALL_MIGRATIONS); // the next boot re-applies every migration
  assert.equal((await ht.ensureOpenStayIndex()).status, 'present');
  const rebound = bind(harness); // a fresh process: empty caches
  assert.equal((await rebound.resolver.ensurePersonForGroup(b.group)).action, 'keep', 'identity survived the restart');
  assert.equal((await harness.query('SELECT COUNT(*)::int AS n FROM driver_people')).rows[0].n, 4, 'RUSLAN, STARKS, OLABODE, QUIET — and nobody twice');
  const open = await harness.query('SELECT COUNT(*)::int AS n FROM driver_road_history WHERE return_to_road_at IS NULL');
  assert.equal(open.rows[0].n, 0, 'no cycle was left open anywhere along the way');
});
