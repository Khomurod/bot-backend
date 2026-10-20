'use strict';

/**
 * The three corrections the owner's review of 20 October 2026 found unable to
 * act, on a real PostgreSQL:
 *
 *   identity.hand_over_unit   a departed driver's truck passes to the new hire,
 *                             by itself (decision B2), and undoes cleanly;
 *   identity.set_group_type   an office chat is retyped even though the person
 *                             layer gave it a placeholder named after itself;
 *   identity.link_telegram    a person's "yes, that is them" on an unnamed
 *                             member actually links the account.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { POOL_PATH, purgeDataLayer } = require('./helpers/purgeDataLayer');

const ALL_MIGRATIONS = allMigrationsSql();
const SERVICE_PATHS = [
  '../services/operations/consistencyService', '../services/operations/corrections/actions',
  '../services/operations/corrections/identityActions', '../services/operations/corrections/unitHandoverActions',
  '../services/operations/corrections/groupActions', '../services/operations/corrections/telegramActions',
  '../services/operations/corrections/apply', '../services/operations/corrections/autoApply',
  '../services/operations/corrections/payloads',
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
    const apply = require('../services/operations/corrections/apply');
    const autoApply = require('../services/operations/corrections/autoApply');
    const { runConsistencySweep } = require('../services/operations/consistencyService');
    return {
      store,
      payloadFor: autoApply.payloadFor,
      sweep: () => runConsistencySweep({ db, store }),
      applyCorrection: (a) => apply.applyCorrection({ ...a, db }),
      revertCorrection: (a) => apply.revertCorrection({ ...a, db }),
      autoApply: (o = {}) => autoApply.runAutoCorrections({ ...o, db, store }),
    };
  } finally {
    delete require.cache[POOL_PATH];
    purgeDataLayer(SERVICE_PATHS);
  }
}

async function harnessWith(t) {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await harness.query("INSERT INTO admins (id, username, password_hash) VALUES (1,'admin','x') ON CONFLICT DO NOTHING");
  return harness;
}

const ADMIN = { id: 1, username: 'admin', roleKeys: ['super_admin'], ip: null };

/** A chat, its profile and the person placed in it. */
async function seedChat(h, {
  id, name, first = null, last = null, unit = null, active = true, driverType = 'company_driver',
  person = name, createdSource = null,
}) {
  await h.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active) VALUES ($1, $2, $3, 'driver', $4)`,
    [id, -900000 - id, name, active]
  );
  await h.query(
    `INSERT INTO driver_profiles (group_id, first_name, last_name, unit_number, driver_type, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, first, last, unit, driverType, active ? 'active' : 'inactive']
  );
  const p = await h.query(
    `INSERT INTO driver_people (display_name, created_source) VALUES ($1, COALESCE($2, 'bot')) RETURNING id`,
    [person, createdSource]
  );
  await h.query(
    `INSERT INTO driver_person_groups (person_id, group_id, started_at, association_source) VALUES ($1, $2, NOW(), 'bot')`,
    [p.rows[0].id, id]
  );
  return p.rows[0].id;
}

const openUnits = async (h) => (await h.query(
  'SELECT person_id, unit_number, fleet_type FROM driver_units WHERE ended_at IS NULL ORDER BY person_id'
)).rows.map((r) => `${r.person_id}:${r.unit_number}:${r.fleet_type}`);

test('B2: a departed driver\'s truck passes to the new hire BY ITSELF, and the undo puts it back', { skip: skipWithoutPg() }, async (t) => {
  const h = await harnessWith(t);
  const { sweep, autoApply, revertCorrection } = bind(h);
  const vernet = await seedChat(h, {
    id: 303269, name: 'WENZE UNIT # 013 VERNET FELICIEN (COMPANY DRIVER ) INACTIVE', first: 'VERNET', last: 'FELICIEN', unit: '013', active: false,
  });
  const prince = await seedChat(h, {
    id: 866389, name: 'WENZE UNIT # 013 PRINCE BURTON / OTIS CONWAY (COMPANY DRIVER)', first: 'PRINCE', last: 'BURTON', unit: '013',
  });
  await h.query(`INSERT INTO driver_units (person_id, unit_number, source, fleet_type) VALUES ($1, '013', 'backfill', 'company')`, [vernet]);

  const { findings } = await sweep();
  assert.deepEqual(findings.filter((f) => f.checkKey.startsWith('identity.unit_')).map((f) => f.checkKey), ['identity.unit_handover']);

  const run = await autoApply({ apply: true });
  assert.equal(run.summary.applied, 1, 'migration 0078 put the check on autopilot');
  assert.deepEqual(await openUnits(h), [`${prince}:013:company`]);

  const correction = (await h.query("SELECT * FROM operational_corrections WHERE action_key = 'identity.hand_over_unit'")).rows[0];
  assert.equal(correction.initiator, 'system');
  await revertCorrection({ correctionId: correction.id, admin: ADMIN, reason: 'test' });
  assert.deepEqual(await openUnits(h), [`${vernet}:013:company`], 'the departed driver holds it again');
});

test('B2: a holder who came BACK between the sweep and the apply keeps the truck', { skip: skipWithoutPg() }, async (t) => {
  const h = await harnessWith(t);
  const { sweep, store, applyCorrection, payloadFor } = bind(h);
  const old = await seedChat(h, { id: 1, name: 'WENZE UNIT # 018 MARQUES JAMERSON', unit: '018', active: false });
  await seedChat(h, { id: 2, name: 'WENZE UNIT # 018 MANSUR NIYAZOV', unit: '018' });
  await h.query(`INSERT INTO driver_units (person_id, unit_number, source, fleet_type) VALUES ($1, '018', 'backfill', 'company')`, [old]);
  await sweep();
  const [finding] = await store.listFindings({ status: 'open', checkKey: 'identity.unit_handover' });
  assert.ok(finding);

  await h.query('UPDATE groups SET active = TRUE WHERE id = 1');
  await assert.rejects(
    applyCorrection({ finding, actionKey: 'identity.hand_over_unit', payload: payloadFor(finding) }),
    /active chat again/
  );
  assert.deepEqual(await openUnits(h), [`${old}:018:company`]);
});

test('an office chat with a placeholder named after itself is retyped; the undo restores both', { skip: skipWithoutPg() }, async (t) => {
  const h = await harnessWith(t);
  const { applyCorrection, revertCorrection } = bind(h);
  await seedChat(h, { id: 3160, name: 'Employee Feedback (Admin)', person: 'Employee Feedback' });

  const correction = await applyCorrection({
    actionKey: 'identity.set_group_type', payload: { groupId: 3160, toType: 'company' }, admin: ADMIN,
  });
  const after = await h.query(
    `SELECT g.group_type, (SELECT COUNT(*)::int FROM driver_person_groups WHERE group_id = 3160 AND ended_at IS NULL) AS placed
       FROM groups g WHERE g.id = 3160`
  );
  assert.deepEqual(after.rows[0], { group_type: 'company', placed: 0 });
  assert.equal(correction.new_values.endedPlaceholder.personName, 'Employee Feedback');

  await revertCorrection({ correctionId: correction.id, admin: ADMIN, reason: 'test' });
  const back = await h.query(
    `SELECT g.group_type, (SELECT COUNT(*)::int FROM driver_person_groups WHERE group_id = 3160 AND ended_at IS NULL) AS placed
       FROM groups g WHERE g.id = 3160`
  );
  assert.deepEqual(back.rows[0], { group_type: 'driver', placed: 1 });
});

test('a REAL driver in a chat is never a placeholder: the retype still refuses', { skip: skipWithoutPg() }, async (t) => {
  const h = await harnessWith(t);
  const { applyCorrection } = bind(h);
  // Named after the chat, but holding a truck: somebody, not a title.
  const person = await seedChat(h, { id: 230835, name: 'HR Personnel', person: 'HR Personnel' });
  await h.query(`INSERT INTO driver_units (person_id, unit_number, source, fleet_type) VALUES ($1, '555', 'manual', 'company')`, [person]);
  await assert.rejects(
    applyCorrection({ actionKey: 'identity.set_group_type', payload: { groupId: 230835 }, admin: ADMIN }),
    /placed in it/
  );
  // A person the ADMIN made is never the bot's placeholder either.
  await seedChat(h, { id: 230836, name: 'HR Personnel', person: 'HR Personnel', createdSource: 'manual' });
  await assert.rejects(
    applyCorrection({ actionKey: 'identity.set_group_type', payload: { groupId: 230836 }, admin: ADMIN }),
    /placed in it/
  );
});

test('a person\'s "yes" on an unnamed member links THAT account, recorded as manual', { skip: skipWithoutPg() }, async (t) => {
  const h = await harnessWith(t);
  const { sweep, store, applyCorrection, payloadFor } = bind(h);
  const person = await seedChat(h, { id: 923105, name: 'WENZE UNIT # 923 TEMESGEN MESSELE', first: 'TEMESGEN', last: 'MESSELE', unit: '923' });
  await h.query(
    `INSERT INTO group_members (group_id, telegram_user_id, first_name) VALUES (923105, 7001, 'ተመስገን')`
  );
  await sweep();
  const [finding] = await store.listFindings({ status: 'open', checkKey: 'identity.telegram_member_unnamed' });
  assert.ok(finding, 'the name does not look like the driver, so a person is asked');
  const payload = payloadFor(finding);
  assert.equal(payload.confirmedUnnamed, true);

  // The same payload WITHOUT the confirmation is the autopilot's, and refuses.
  await assert.rejects(
    applyCorrection({ actionKey: 'identity.link_telegram', payload: { ...payload, confirmedUnnamed: false } }),
    /no longer resolves to one account/
  );
  const correction = await applyCorrection({ finding, actionKey: 'identity.link_telegram', payload, admin: ADMIN });
  const link = await h.query('SELECT person_id, telegram_user_id::text AS tg, link_source FROM driver_person_telegram_identities');
  assert.deepEqual(link.rows, [{ person_id: person, tg: '7001', link_source: 'manual' }]);
  assert.equal(correction.initiator, 'admin:1');
});
