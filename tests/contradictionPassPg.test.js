'use strict';

/**
 * The contradiction pass end to end, on real rows.
 *
 * WHY THIS EXISTS WHEN THE PASS ALREADY HAS UNIT TESTS: those stub the data
 * layer, so they prove the pass calls it and nothing about whether the calls
 * SUCCEED. This session produced that failure twice — `readRetention` asking
 * for columns that do not exist, and a verifier querying `state` where the
 * column is `internal_alert_state` — both invisible to a stub, both a silent
 * no-op in production.
 *
 * So this drives the real screen, the real context read and the real
 * `upsertFinding` against the real schema, and asserts the row that lands.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const pass = require('../services/operations/contradictionPass');
const { assess } = require('../lib/retention/signals');

const ALL_MIGRATIONS = allMigrationsSql();

function quietSignals() {
  const { signals } = assess({
    baselineMessages: 40, recentMessages: 0, avgSentiment: 0,
    roadWeeksOverAllowance: 0, daysOnRoad: 10,
  });
  return signals;
}

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const layer = h.loadDataLayer(['driverContext', 'operationalFindings', 'driverPeople']);
  const notices = [];
  const deps = {
    context: layer.driverContext,
    findings: layer.operationalFindings,
    async notify(n) { notices.push(n); return { recorded: true, delivered: true }; },
  };
  return { h, deps, notices, store: layer.operationalFindings, people: layer.driverPeople };
}

async function aDriverAtHomeAndDriving(h, people) {
  const person = await people.createPerson({ displayName: 'SPLIT BRAIN', normalizedKey: 'split-brain' });
  await h.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES (9001, -19001, 'WENZE UNIT # 91 SPLIT BRAIN', 'driver', TRUE)`
  );
  await h.query(
    `INSERT INTO driver_person_groups (person_id, group_id, started_at, association_source)
     VALUES ($1, 9001, NOW(), 'manual')`,
    [person.id]
  );
  await h.query(
    `INSERT INTO driver_home_status (group_id, state, state_since, last_status_at)
     VALUES (9001, 'home', NOW() - INTERVAL '3 days', NOW())`
  );
  await h.query(
    `INSERT INTO load_lifecycle (order_id, group_id, phase, confidence, updated_at)
     VALUES ('ORD-91', 9001, 'in_transit', 'high', NOW())`
  );
  return person;
}

test('A REAL DISAGREEMENT BECOMES A REAL FINDING, through the real data layer',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, deps, notices, store, people } = await setup(t);
    const person = await aDriverAtHomeAndDriving(h, people);

    const summary = await pass.runContradictionPass({ deps });

    assert.equal(summary.candidates, 1, 'the screen found them');
    assert.equal(summary.read, 1);
    assert.equal(summary.filed, 1);
    assert.deepEqual(summary.errors, []);

    const rows = (await h.query(
      "SELECT * FROM operational_findings WHERE check_key LIKE 'context.%'"
    )).rows;
    assert.equal(rows.length, 1, 'and the row really landed — no constraint refused it');
    assert.equal(rows[0].check_key, 'context.home_while_working');
    assert.equal(rows[0].tier, 'warning', 'the tier with no apply action at all');
    assert.equal(rows[0].subject_type, 'person');
    assert.equal(String(rows[0].subject_id), String(person.id));
    assert.equal(rows[0].proposed_change_json, null, 'there is nothing to propose');
    assert.equal(rows[0].confidence, null);

    const evidence = typeof rows[0].evidence_json === 'string'
      ? JSON.parse(rows[0].evidence_json) : rows[0].evidence_json;
    assert.deepEqual(evidence.sides, ['home_time', 'loads']);
    assert.equal(evidence.orderId, 'ORD-91');
    assert.ok(evidence.coverage, 'with how much of the picture was readable');

    assert.equal(notices.length, 1);
    assert.match(notices[0].action, /will not pick a side/);
    assert.equal(await store.countFindings({ status: 'open' }), 1);
  });

test('AND IT IS RESOLVED ONCE THE DISAGREEMENT CLEARS',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, deps, store, people } = await setup(t);
    await aDriverAtHomeAndDriving(h, people);

    await pass.runContradictionPass({ deps });
    assert.equal(await store.countFindings({ status: 'open' }), 1);

    // Dispatch closes the load: the two systems agree again.
    await h.query("UPDATE load_lifecycle SET phase = 'delivered' WHERE order_id = 'ORD-91'");

    const second = await pass.runContradictionPass({ deps });
    assert.equal(second.candidates, 0, 'the screen no longer selects them');
    assert.equal(
      await store.countFindings({ status: 'open' }), 0,
      'and the finding is closed rather than telling operators about a disagreement '
      + 'that no longer exists'
    );
  });

test('a quiet driver who really is quiet produces nothing at all',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, deps, store, people } = await setup(t);
    const person = await people.createPerson({ displayName: 'REALLY QUIET', normalizedKey: 'rq' });
    await h.query(
      `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
       VALUES (9002, -19002, 'WENZE UNIT # 92 REALLY QUIET', 'driver', TRUE)`
    );
    await h.query(
      `INSERT INTO driver_person_groups (person_id, group_id, started_at, association_source)
       VALUES ($1, 9002, NOW(), 'manual')`,
      [person.id]
    );
    await h.query(
      `INSERT INTO driver_retention_assessments
         (person_id, group_id, score, level, signals, first_seen_at, last_seen_at)
       VALUES ($1, 9002, 55, 'urgent', $2::jsonb, NOW() - INTERVAL '5 days', NOW())`,
      [person.id, JSON.stringify(quietSignals())]
    );

    const summary = await pass.runContradictionPass({ deps });
    assert.equal(summary.candidates, 0, 'nothing disagrees — every source says quiet');
    assert.equal(summary.filed, 0);
    assert.equal(await store.countFindings({ status: 'open' }), 0);
  });
