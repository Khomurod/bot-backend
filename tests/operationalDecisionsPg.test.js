'use strict';

/**
 * The decision journal against a real PostgreSQL.
 *
 * What is proved here cannot be proved with a fake: the KEY that bounds the
 * table. A row per decision per pass was costed before this was written — the
 * load watch alone re-decides 235 loads every ten minutes, about 44,000 rows a
 * day across the set, 16 million in a year on free infrastructure to say the
 * same thing repeatedly. That is the mistake migration 0042 had just been
 * written to undo one table over.
 *
 * So: the same verdict recurring must count itself in ONE row, and a CHANGE of
 * verdict must write another, because a load that flipped between `act` and
 * `hold` five times is the single most useful thing this table can say.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { operationalDecisions } = h.loadDataLayer(['operationalDecisions']);
  return { h, d: operationalDecisions };
}

const base = (over = {}) => ({
  checkKey: 'load_lifecycle.conflict', subjectType: 'load', subjectId: '9001',
  verdict: 'hold', confidence: 40, mode: 'suggest',
  reason: 'the board and the truck disagree',
  sources: [{ source: 'board', fresh: true, agrees: true }],
  ...over,
});

test('THE SAME VERDICT RECURRING IS ONE ROW THAT COUNTS ITSELF',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, d } = await setup(t);
    await d.recordDecision(base());
    await d.recordDecision(base());
    const row = await d.recordDecision(base());
    assert.equal(row.timesDecided, 3);
    const n = (await h.query('SELECT COUNT(*)::int AS n FROM operational_decisions')).rows[0].n;
    assert.equal(n, 1, 'three passes, one row — 44,000 a day is the alternative');
  });

test('a CHANGE of verdict is its own row, because that is the signal',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, d } = await setup(t);
    await d.recordDecision(base({ verdict: 'hold' }));
    await d.recordDecision(base({ verdict: 'act', confidence: 90 }));
    const n = (await h.query('SELECT COUNT(*)::int AS n FROM operational_decisions')).rows[0].n;
    assert.equal(n, 2);
  });

test('a different subject is a different decision', { skip: skipWithoutPg() }, async (t) => {
  const { h, d } = await setup(t);
  await d.recordDecision(base({ subjectId: '9001' }));
  await d.recordDecision(base({ subjectId: '9002' }));
  const n = (await h.query('SELECT COUNT(*)::int AS n FROM operational_decisions')).rows[0].n;
  assert.equal(n, 2);
});

test('THE SCHEMA REFUSES A CONFIDENCE ON "I DO NOT KNOW"',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, d } = await setup(t);
    // The data layer coerces it away…
    const row = await d.recordDecision(base({ verdict: 'unknown', confidence: 80 }));
    assert.equal(row.confidence, null);
    // …and the schema refuses it even when the layer is bypassed, because a
    // number attached to "I do not know" is one somebody compares to a
    // threshold.
    await assert.rejects(() => h.query(
      `INSERT INTO operational_decisions
         (check_key, subject_type, subject_id, verdict, confidence, reason)
       VALUES ('x', 'load', '1', 'unknown', 50, 'r')`
    ));
  });

test('an unrecognised verdict is refused by the schema', { skip: skipWithoutPg() }, async (t) => {
  const { h } = await setup(t);
  await assert.rejects(() => h.query(
    `INSERT INTO operational_decisions (check_key, subject_type, subject_id, verdict, reason)
     VALUES ('x', 'load', '1', 'probably', 'r')`
  ));
});

test('an outcome is graded later, and only from the allowed words',
  { skip: skipWithoutPg() }, async (t) => {
    const { d } = await setup(t);
    const row = await d.recordDecision(base({ verdict: 'act', confidence: 90, actionKey: 'close_cycle' }));
    assert.equal(await d.recordOutcome(row.id, 'confirmed', 'the truck moved'), true);
    assert.equal(await d.recordOutcome(row.id, 'probably_fine'), false,
      'the vocabulary is closed, so a summary cannot grow a category nobody defined');
  });

test('the verifier is handed only decisions that ACTED and are ungraded',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, d } = await setup(t);
    await d.recordDecision(base({ verdict: 'act', confidence: 90, actionKey: 'close_cycle', subjectId: 'A' }));
    await d.recordDecision(base({ verdict: 'hold', subjectId: 'B' }));
    await d.recordDecision(base({ verdict: 'act', confidence: 90, actionKey: 'close_cycle', subjectId: 'C' }));
    await h.query("UPDATE operational_decisions SET last_decided_at = NOW() - INTERVAL '2 hours'");
    const acted = await d.recordDecision(base({ verdict: 'act', confidence: 91, actionKey: 'close_cycle', subjectId: 'C' }));
    await d.recordOutcome(acted.id, 'confirmed');
    await h.query("UPDATE operational_decisions SET last_decided_at = NOW() - INTERVAL '2 hours'");

    const queue = await d.listUnverifiedActions({ olderThanMinutes: 30 });
    const ids = queue.map((r) => r.subjectId);
    assert.deepEqual(ids, ['A'], 'a hold never acted, and C was already graded');
  });

test('a decision too fresh to have an outcome yet is left alone',
  { skip: skipWithoutPg() }, async (t) => {
    const { d } = await setup(t);
    await d.recordDecision(base({ verdict: 'act', confidence: 90, actionKey: 'close_cycle' }));
    const queue = await d.listUnverifiedActions({ olderThanMinutes: 30 });
    assert.deepEqual(queue, [], 'grading an action a second after taking it proves nothing');
  });

test('the summary counts UNKNOWN separately from HOLD', { skip: skipWithoutPg() }, async (t) => {
  const { d } = await setup(t);
  await d.recordDecision(base({ verdict: 'hold', subjectId: 'A' }));
  await d.recordDecision(base({ verdict: 'unknown', confidence: null, subjectId: 'B' }));
  await d.recordDecision(base({ verdict: 'unknown', confidence: null, subjectId: 'C' }));
  const out = await d.summariseDecisions({});
  assert.equal(out.byVerdict.hold, 1);
  assert.equal(out.byVerdict.unknown, 2,
    'a week of unknown is a data problem; a week of hold is a quiet fleet. '
    + 'One number for both hides the only one worth acting on');
});

test('the summary reports OCCURRENCES as well as rows', { skip: skipWithoutPg() }, async (t) => {
  const { d } = await setup(t);
  await d.recordDecision(base());
  await d.recordDecision(base());
  const out = await d.summariseDecisions({});
  assert.equal(out.total, 1, 'one distinct decision');
  assert.equal(out.occurrences, 2, 'reached twice');
});

test('the prune never removes an action still awaiting its outcome',
  { skip: skipWithoutPg() }, async (t) => {
    const { h, d } = await setup(t);
    await d.recordDecision(base({ verdict: 'act', confidence: 90, actionKey: 'close_cycle', subjectId: 'A' }));
    await d.recordDecision(base({ verdict: 'hold', subjectId: 'B' }));
    await h.query("UPDATE operational_decisions SET last_decided_at = NOW() - INTERVAL '200 days'");
    const removed = await d.pruneDecisions({ olderThanDays: 90 });
    assert.equal(removed, 1, 'the hold went');
    const left = (await h.query('SELECT subject_id FROM operational_decisions')).rows;
    assert.deepEqual(left.map((r) => r.subject_id), ['A'],
      'an action nobody ever graded is the one record worth keeping longest');
  });

test('shadow records what it WOULD have done, and no action key',
  { skip: skipWithoutPg() }, async (t) => {
    const { d } = await setup(t);
    const row = await d.recordDecision(base({
      verdict: 'act', confidence: 95, shadow: true,
      wouldHave: { action: 'close_cycle', cycleId: 12 },
    }));
    assert.equal(row.shadow, true);
    assert.deepEqual(row.wouldHave, { action: 'close_cycle', cycleId: 12 });
    assert.equal(row.actionKey, null, 'shadow did nothing, so there is nothing to name');
  });
