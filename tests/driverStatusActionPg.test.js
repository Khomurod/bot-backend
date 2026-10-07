'use strict';

/**
 * The owner choosing whether a driver is working — against a real PostgreSQL.
 *
 * Production, 2026-10-07: the owner answered "Yes" to a status question about
 * a chat the AI had marked inactive. The only action wired to it refuses
 * anything the bot did not observe, so nothing changed and the owner was told
 * "Somebody fixed it first". These pin the replacement: a person-only action
 * that writes BOTH records, marks the decision as manual so the AI classifier
 * leaves it alone, passes the schema's who-may-apply CHECK when the person is
 * a Telegram operator, and undoes cleanly.
 *
 * And migration 0068, which moves the rows already filed under the old key.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { POOL_PATH, purgeDataLayer } = require('./helpers/purgeDataLayer');

const ALL_MIGRATIONS = allMigrationsSql();
const MIGRATION_0068 = fs.readFileSync(
  path.resolve(__dirname, '../database/migrations/0068_status_needs_decision.sql'), 'utf8'
);
const SERVICE_PATHS = [
  '../services/operations/corrections/actions', '../services/operations/corrections/statusActions',
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

const OPERATOR = { telegramUserId: '424242' };

async function seedDriver(h, { id, active, source, profileStatus }) {
  await h.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active, status_source)
     VALUES ($1, $2, 'WENZE UNIT # 7777 TEST DRIVER', 'driver', $3, $4)`,
    [id, -800000 - id, active, source]
  );
  await h.query(
    `INSERT INTO driver_profiles (group_id, first_name, last_name, status)
     VALUES ($1, 'TEST', 'DRIVER', $2)`,
    [id, profileStatus]
  );
}

async function state(h, id) {
  const g = await h.query('SELECT active, status_source FROM groups WHERE id = $1', [id]);
  const p = await h.query('SELECT status FROM driver_profiles WHERE group_id = $1', [id]);
  return { active: g.rows[0].active, source: g.rows[0].status_source, profile: p.rows[0].status };
}

test('a Telegram operator\'s answer sets both records on an AI-set chat, and reverts', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { applyCorrection, revertCorrection } = bind(h);
  await seedDriver(h, { id: 7101, active: false, source: 'ai', profileStatus: 'active' });

  const correction = await applyCorrection({
    actionKey: 'identity.set_driver_status',
    payload: { groupId: 7101, toStatus: 'active' },
    admin: OPERATOR, reason: 'Approved in the notification group.',
  });
  assert.equal(correction.initiator, 'telegram:424242');
  assert.deepEqual(await state(h, 7101), { active: true, source: 'manual', profile: 'active' },
    'manual, so the AI classifier will not overrule the owner on its next pass');

  await revertCorrection({ correctionId: correction.id, admin: { id: null }, reason: 'undo' });
  assert.deepEqual(await state(h, 7101), { active: false, source: 'ai', profile: 'active' });
});

test('"not working" sets both records the other way', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { applyCorrection } = bind(h);
  await seedDriver(h, { id: 7102, active: true, source: 'manual', profileStatus: 'inactive' });

  await applyCorrection({
    actionKey: 'identity.set_driver_status',
    payload: { groupId: 7102, toStatus: 'inactive' },
    admin: OPERATOR, reason: 'test',
  });
  assert.deepEqual(await state(h, 7102), { active: false, source: 'manual', profile: 'inactive' });
});

test('nothing to change says so in plain words', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { applyCorrection } = bind(h);
  await seedDriver(h, { id: 7103, active: true, source: 'ai', profileStatus: 'active' });

  await assert.rejects(
    () => applyCorrection({
      actionKey: 'identity.set_driver_status',
      payload: { groupId: 7103, toStatus: 'active' }, admin: OPERATOR, reason: 'test',
    }),
    (err) => err.name === 'StaleCorrectionError' && /already shows working/.test(err.plain)
  );
});

test('THE SYSTEM CANNOT APPLY IT — a person chooses', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { applyCorrection } = bind(h);
  await seedDriver(h, { id: 7104, active: false, source: 'ai', profileStatus: 'active' });

  await assert.rejects(
    () => applyCorrection({
      actionKey: 'identity.set_driver_status',
      payload: { groupId: 7104, toStatus: 'active' }, reason: 'test',
    }),
    /cannot be applied by the system/
  );
  assert.deepEqual(await state(h, 7104), { active: false, source: 'ai', profile: 'active' });
});

test('migration 0068 moves AI/admin status rows and their memories, once', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const finding = (subjectId, tier, status) => h.query(
    `INSERT INTO operational_findings
       (check_key, subject_type, subject_id, title, severity, tier, status, dismissed_by, dismiss_reason)
     VALUES ('identity.status_disagreement', 'group', $1, 'status', 'warning', $2, $3,
             CASE WHEN $3 = 'dismissed' THEN 'telegram:1' END,
             CASE WHEN $3 = 'dismissed' THEN 'he is on vacation' END)`,
    [subjectId, tier, status]
  );
  await finding('1', 'approval', 'dismissed');
  await finding('2', 'auto', 'open');
  await h.query(
    `INSERT INTO control_knowledge (check_key, subject_type, subject_id, answer_action, evidence_fingerprint)
     VALUES ('identity.status_disagreement', 'group', '1', 'dismiss', $1),
            ('identity.status_disagreement', 'group', '2', 'dismiss', $1)`,
    ['f'.repeat(32)]
  );

  await h.query(MIGRATION_0068);
  await h.query(MIGRATION_0068); // idempotent

  const findings = await h.query(
    'SELECT subject_id, check_key, status FROM operational_findings ORDER BY subject_id'
  );
  assert.deepEqual(findings.rows, [
    { subject_id: '1', check_key: 'identity.status_needs_decision', status: 'dismissed' },
    { subject_id: '2', check_key: 'identity.status_disagreement', status: 'open' },
  ], 'the owner\'s "no" stays attached; the bot-observed row stays put');
  const memories = await h.query('SELECT subject_id, check_key FROM control_knowledge ORDER BY subject_id');
  assert.deepEqual(memories.rows, [
    { subject_id: '1', check_key: 'identity.status_needs_decision' },
    { subject_id: '2', check_key: 'identity.status_disagreement' },
  ]);
});
