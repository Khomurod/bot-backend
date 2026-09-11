'use strict';

/**
 * Every verifier's SQL, against the real schema.
 *
 * WHAT ONLY A REAL DATABASE PROVES: that the columns exist. A verifier is a
 * query and a stub answers whatever it is told to, so a unit test cannot tell
 * a correct column name from a wrong one — and a wrong one throws, is swallowed
 * per decision, and leaves the verifier silently useless while looking present.
 *
 * That is not hypothetical twice over. `readRetention` asked for `urgency` and
 * `assessed_at`, neither of which exists, and the retention section read as
 * unknown for every driver in the fleet. And the abandoned-alert verifier in
 * this very file first asked for `state` on `home_time_requests`, where the
 * column is `internal_alert_state` — caught here rather than in production.
 *
 * So each verifier is RUN, and its result is compared with what its action
 * records, which is the pair that actually has to agree.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { SUBJECTS } = require('../services/decisions/verifyPass');
const { compareWritten, OUTCOMES } = require('../lib/decisions/verification');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  await h.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES (8001, -18001, 'WENZE UNIT # 77 A DRIVER', 'driver', TRUE)`
  );
  await h.query(
    `INSERT INTO driver_people (id, display_name, normalized_key)
     VALUES (501, 'A DRIVER', 'a-driver')`
  );
  return h;
}

/** The pool the harness owns, shaped like the client a verifier receives. */
const clientFor = (h) => ({ query: (sql, params) => h.query(sql, params) });

test('EVERY VERIFIER RUNS AGAINST THE REAL SCHEMA WITHOUT THROWING',
  { skip: skipWithoutPg() }, async (t) => {
    // The blunt one. A wrong column name is a runtime error that this catches
    // and no stub ever can.
    const h = await setup(t);
    const client = clientFor(h);
    const correction = { new_values: { requestIds: [1] } };

    for (const [actionKey, subject] of Object.entries(SUBJECTS)) {
      // eslint-disable-next-line no-await-in-loop
      await assert.doesNotReject(
        () => subject.read(client, 8001, correction),
        `${actionKey}'s read must be valid SQL against the real schema`
      );
    }
  });

test('the person verifier confirms a live association and expires a closed one',
  { skip: skipWithoutPg() }, async (t) => {
    const h = await setup(t);
    const client = clientFor(h);
    await h.query(
      `INSERT INTO driver_person_groups (person_id, group_id, started_at, association_source)
       VALUES (501, 8001, NOW(), 'manual')`
    );

    const wrote = { personId: 501, how: 'create', ambiguous: false };
    const current = await SUBJECTS['identity.ensure_person'].read(client, 8001);
    assert.equal(compareWritten({ wrote, current }).outcome, OUTCOMES.CONFIRMED);

    // Somebody moved the driver: the association is closed, so the subject is
    // gone rather than wrong.
    await h.query('UPDATE driver_person_groups SET ended_at = NOW() WHERE group_id = 8001');
    const after = await SUBJECTS['identity.ensure_person'].read(client, 8001);
    assert.equal(compareWritten({ wrote, current: after }).outcome, OUTCOMES.EXPIRED);
  });

test('the unit verifier notices the truck changing under it',
  { skip: skipWithoutPg() }, async (t) => {
    const h = await setup(t);
    const client = clientFor(h);
    await h.query(
      `INSERT INTO driver_person_groups (person_id, group_id, started_at, association_source)
       VALUES (501, 8001, NOW(), 'manual')`
    );
    await h.query(
      `INSERT INTO driver_units (person_id, unit_number, source, started_at)
       VALUES (501, '77', 'manual', NOW())`
    );

    const wrote = { unitNumber: '77', personId: 501 };
    assert.equal(
      compareWritten({ wrote, current: await SUBJECTS['identity.sync_unit'].read(client, 8001) })
        .outcome,
      OUTCOMES.CONFIRMED
    );

    await h.query("UPDATE driver_units SET unit_number = '88' WHERE person_id = 501");
    assert.equal(
      compareWritten({ wrote, current: await SUBJECTS['identity.sync_unit'].read(client, 8001) })
        .outcome,
      OUTCOMES.CONTRADICTED
    );
  });

test('the return-to-road verifier notices somebody sending them home again',
  { skip: skipWithoutPg() }, async (t) => {
    const h = await setup(t);
    const client = clientFor(h);
    const at = '2026-09-01T00:00:00Z';
    await h.query(
      `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at)
       VALUES (8001, 'road', $1, $1)`,
      [at]
    );

    const wrote = { state: 'road', state_since: at };
    assert.equal(
      compareWritten({
        wrote,
        current: await SUBJECTS['home_time.mark_returned_to_road'].read(client, 8001),
      }).outcome,
      OUTCOMES.CONFIRMED
    );

    await h.query("UPDATE driver_home_status SET state = 'home' WHERE group_id = 8001");
    assert.equal(
      compareWritten({
        wrote,
        current: await SUBJECTS['home_time.mark_returned_to_road'].read(client, 8001),
      }).outcome,
      OUTCOMES.CONTRADICTED,
      'a person disagreeing IS the information — it is recorded, never undone'
    );
  });

test('THE ABANDONED-ALERT VERIFIER READS THE COLUMN THAT EXISTS',
  { skip: skipWithoutPg() }, async (t) => {
    // It first asked for `state`; the column is `internal_alert_state`. That
    // query throws, is swallowed per decision, and the verifier looks present
    // while doing nothing.
    const h = await setup(t);
    const client = clientFor(h);
    const ids = [];
    for (const n of [1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await h.query(
        `INSERT INTO home_time_requests (group_id, status, internal_alert_state, requested_at)
         VALUES (8001, 'pending', 'abandoned', NOW()) RETURNING id`
      );
      ids.push(r.rows[0].id);
      assert.ok(n);
    }
    const correction = { new_values: { state: 'abandoned', requestIds: ids } };
    const wrote = correction.new_values;

    const current = await SUBJECTS['home_time.abandon_exhausted_alerts']
      .read(client, 'outbox', correction);
    assert.equal(current.state, 'abandoned');
    assert.equal(compareWritten({ wrote, current }).outcome, OUTCOMES.CONFIRMED);

    // ONE ROW RESTORED IS THE CONTRADICTION WORTH CATCHING.
    await h.query(
      "UPDATE home_time_requests SET internal_alert_state = 'failed' WHERE id = $1", [ids[0]]
    );
    const after = await SUBJECTS['home_time.abandon_exhausted_alerts']
      .read(client, 'outbox', correction);
    assert.equal(after.state, 'partly_restored');
    assert.equal(compareWritten({ wrote, current: after }).outcome, OUTCOMES.CONTRADICTED);
  });
