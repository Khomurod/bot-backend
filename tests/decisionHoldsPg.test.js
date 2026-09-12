'use strict';

/**
 * "The most recent decision about this subject was a hold" is a DISTINCT ON
 * query, and the reason it has to be one cannot be shown without a real
 * database: the journal keeps one row per (check, subject, VERDICT), so a
 * subject held on Monday and acted on Tuesday has two live rows and reading the
 * hold alone reports a decision that has been superseded.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const loaded = h.loadDataLayer(['operationalDecisions']);
  return { h, ...loaded };
}

const SUBJECT = { checkKey: 'identity.stale_unit_assignment', subjectType: 'group', subjectId: '49' };

test('a held subject is reported, with the reason the journal recorded', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { operationalDecisions } = await setup(t);
  await operationalDecisions.recordDecision({
    ...SUBJECT, verdict: 'hold', confidence: 62, mode: 'autopilot',
    reason: 'confidence 62 below the floor of 75',
  });
  const holds = await operationalDecisions.currentHolds();
  const got = holds.get('identity.stale_unit_assignment|group|49');
  assert.ok(got);
  assert.equal(got.verdict, 'hold');
  assert.match(got.reason, /below the floor/);
});

test('AN "I CANNOT TELL" COUNTS TOO — it is a different answer, not a weaker one', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { operationalDecisions } = await setup(t);
  await operationalDecisions.recordDecision({
    ...SUBJECT, verdict: 'unknown', mode: 'autopilot', reason: 'no usable source',
  });
  const holds = await operationalDecisions.currentHolds();
  assert.equal(holds.get('identity.stale_unit_assignment|group|49').verdict, 'unknown');
});

test('A SUPERSEDED HOLD IS NOT REPORTED — this is why it is DISTINCT ON', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { operationalDecisions, h } = await setup(t);
  await operationalDecisions.recordDecision({
    ...SUBJECT, verdict: 'hold', confidence: 62, mode: 'autopilot', reason: 'not sure',
  });
  await operationalDecisions.recordDecision({
    ...SUBJECT, verdict: 'act', confidence: 95, mode: 'autopilot', reason: 'sure now',
  });
  // Both rows exist — the journal keeps one per verdict, on purpose.
  const rows = await h.query(
    "SELECT COUNT(*)::int AS n FROM operational_decisions WHERE subject_id = '49'"
  );
  assert.equal(rows.rows[0].n, 2);

  const holds = await operationalDecisions.currentHolds();
  assert.equal(holds.get('identity.stale_unit_assignment|group|49'), undefined,
    'asking about something already done is the failure this query prevents');
});

test('a hold nobody is making any more falls out of the window', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { operationalDecisions, h } = await setup(t);
  await operationalDecisions.recordDecision({
    ...SUBJECT, verdict: 'hold', confidence: 62, mode: 'autopilot', reason: 'not sure',
  });
  await h.query(
    "UPDATE operational_decisions SET last_decided_at = NOW() - INTERVAL '4 days'"
  );
  const holds = await operationalDecisions.currentHolds({ withinHours: 24 });
  assert.equal(holds.size, 0);
  // A live hold is re-derived every sweep, so one that has stopped moving is a
  // decision nobody is making — quoting its reason would be quoting the past.
  const wider = await operationalDecisions.currentHolds({ withinHours: 24 * 7 });
  assert.equal(wider.size, 1);
});

test('a shadow decision is not a hold anybody needs to answer', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { operationalDecisions } = await setup(t);
  await operationalDecisions.recordDecision({
    ...SUBJECT, verdict: 'hold', confidence: 62, mode: 'autopilot', shadow: true,
    reason: 'trial run',
  });
  const holds = await operationalDecisions.currentHolds();
  assert.equal(holds.size, 0, 'a trial is not a decision the owner has to unblock');
});
