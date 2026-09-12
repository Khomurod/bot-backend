'use strict';

/**
 * Retyping a chat that was never a driver's — against a real PostgreSQL.
 *
 * The two refusals are the substance, and both are only observable under a
 * lock against real rows: a chat somebody already retyped, and a chat with a
 * driver actually placed in it. The second is the important one — the person
 * layer having put a driver there is stronger evidence about what the room is
 * for than any reading of its name.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { POOL_PATH, purgeDataLayer } = require('./helpers/purgeDataLayer');

const ALL_MIGRATIONS = allMigrationsSql();
const SERVICE_PATHS = [
  '../services/operations/corrections/actions', '../services/operations/corrections/groupActions',
  '../services/operations/corrections/apply',
].map((p) => path.resolve(__dirname, `${p}.js`));

function bind(harness) {
  purgeDataLayer(SERVICE_PATHS);
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true,
    exports: { pool: harness.pool, query: harness.query, ping: async () => true },
  };
  try {
    const db = { pool: harness.pool, query: harness.query };
    const apply = require('../services/operations/corrections/apply');
    return {
      applyCorrection: (a) => apply.applyCorrection({ ...a, db }),
      revertCorrection: (a) => apply.revertCorrection({ ...a, db }),
    };
  } finally {
    delete require.cache[POOL_PATH];
    purgeDataLayer(SERVICE_PATHS);
  }
}

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await h.query("INSERT INTO admins (id, username, password_hash) VALUES (1,'admin','x') ON CONFLICT DO NOTHING");
  return h;
}

const ADMIN = { id: 1, username: 'admin', roleKeys: ['super_admin'], ip: null };

async function seedChat(h, { id, name, type = 'driver' }) {
  await h.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES ($1, $2, $3, $4, TRUE)`,
    [id, -900000 - id, name, type]
  );
}

test('an admin chat is retyped, and the revert puts it back', { skip: skipWithoutPg() }, async (t) => {
  const h = await setup(t);
  const { applyCorrection, revertCorrection } = bind(h);
  await seedChat(h, { id: 9001, name: 'Employee Feedback (Admin)' });

  const correction = await applyCorrection({
    actionKey: 'identity.set_group_type',
    payload: { groupId: 9001, toType: 'company' },
    admin: ADMIN, reason: 'not a driver',
  });
  let row = await h.query('SELECT group_type FROM groups WHERE id = 9001');
  assert.equal(row.rows[0].group_type, 'company');

  await revertCorrection({ correctionId: correction.id, admin: ADMIN, reason: 'undo' });
  row = await h.query('SELECT group_type FROM groups WHERE id = 9001');
  assert.equal(row.rows[0].group_type, 'driver');
});

test('A CHAT WITH A DRIVER PLACED IN IT IS NOT AN ADMIN CHAT', { skip: skipWithoutPg() }, async (t) => {
  // The person layer outranks a title regex. This is the refusal that stops a
  // driver whose chat is named unusually from losing their documents and
  // broadcasts on a 65%-confidence guess.
  const h = await setup(t);
  const { applyCorrection } = bind(h);
  await seedChat(h, { id: 9002, name: 'HR Personnel' });
  const person = await h.query(
    `INSERT INTO driver_people (display_name, normalized_key) VALUES ('REAL DRIVER','realdriver') RETURNING id`
  );
  await h.query(
    `INSERT INTO driver_person_groups (person_id, group_id, started_at, association_source)
     VALUES ($1, 9002, NOW(), 'manual')`,
    [person.rows[0].id]
  );

  await assert.rejects(
    () => applyCorrection({
      actionKey: 'identity.set_group_type',
      payload: { groupId: 9002 }, admin: ADMIN, reason: 'test',
    }),
    /that is not an admin chat/
  );
  const row = await h.query('SELECT group_type FROM groups WHERE id = 9002');
  assert.equal(row.rows[0].group_type, 'driver', 'nothing was changed');
});

test('a chat somebody already retyped is left alone', { skip: skipWithoutPg() }, async (t) => {
  const h = await setup(t);
  const { applyCorrection } = bind(h);
  await seedChat(h, { id: 9003, name: 'Wenze Facebook Leads', type: 'company' });

  await assert.rejects(
    () => applyCorrection({
      actionKey: 'identity.set_group_type',
      payload: { groupId: 9003 }, admin: ADMIN, reason: 'test',
    }),
    /already typed/
  );
});

test('it retypes to company and nothing else', { skip: skipWithoutPg() }, async (t) => {
  const h = await setup(t);
  const { applyCorrection } = bind(h);
  await seedChat(h, { id: 9004, name: 'Automatic updating (Test)' });

  await assert.rejects(
    () => applyCorrection({
      actionKey: 'identity.set_group_type',
      payload: { groupId: 9004, toType: 'dispatcher' }, admin: ADMIN, reason: 'test',
    }),
    /only retypes to "company"/
  );
});

test('THE SYSTEM CANNOT APPLY IT — approval tier, a person clicks', { skip: skipWithoutPg() }, async (t) => {
  // The check reads a TITLE at 65 confidence. A guess does not get to stop a
  // chat receiving load documents.
  const h = await setup(t);
  const { applyCorrection } = bind(h);
  await seedChat(h, { id: 9005, name: 'Driver Feedback (Admin)' });

  await assert.rejects(
    () => applyCorrection({
      actionKey: 'identity.set_group_type',
      payload: { groupId: 9005 }, admin: null, reason: 'test',
    }),
    /cannot be applied by the system/
  );
});

test('a revert leaves a type somebody changed again by hand', { skip: skipWithoutPg() }, async (t) => {
  const h = await setup(t);
  const { applyCorrection, revertCorrection } = bind(h);
  await seedChat(h, { id: 9006, name: 'Employee Feedback (Admin)' });

  const correction = await applyCorrection({
    actionKey: 'identity.set_group_type',
    payload: { groupId: 9006 }, admin: ADMIN, reason: 'test',
  });
  await h.query("UPDATE groups SET group_type = 'dispatcher' WHERE id = 9006");

  await assert.rejects(
    () => revertCorrection({ correctionId: correction.id, admin: ADMIN, reason: 'undo' }),
    /no longer typed/
  );
  const row = await h.query('SELECT group_type FROM groups WHERE id = 9006');
  assert.equal(row.rows[0].group_type, 'dispatcher', "the administrator's choice survived");
});
