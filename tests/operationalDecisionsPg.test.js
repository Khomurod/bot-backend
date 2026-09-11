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

// ── the feedback loop: how a source has actually performed ──────────────────

test('SOURCE AGREEMENT IS MEASURED FROM GRADED DECISIONS ONLY',
  { skip: skipWithoutPg() }, async (t) => {
    const { d } = await setup(t);
    const src = (source) => [{ source, fresh: true, agrees: true }];

    const a = await d.recordDecision(base({
      subjectId: 'A', verdict: 'act', confidence: 90, actionKey: 'x', sources: src('gps'),
    }));
    await d.recordOutcome(a.id, 'confirmed');

    const b = await d.recordDecision(base({
      subjectId: 'B', verdict: 'act', confidence: 90, actionKey: 'x', sources: src('gps'),
    }));
    await d.recordOutcome(b.id, 'contradicted');

    // Ungraded: says nothing about its sources and must not be counted.
    await d.recordDecision(base({
      subjectId: 'C', verdict: 'act', confidence: 90, actionKey: 'x', sources: src('gps'),
    }));

    const stats = await d.sourceAgreement({});
    assert.deepEqual(stats.gps, { graded: 2, confirmed: 1 },
      'the third decision has no outcome, so it is evidence about nothing yet');
  });

test('a decision citing several sources counts for each of them',
  { skip: skipWithoutPg() }, async (t) => {
    const { d } = await setup(t);
    const row = await d.recordDecision(base({
      verdict: 'act', confidence: 90, actionKey: 'x',
      sources: [
        { source: 'gps', fresh: true, agrees: true },
        { source: 'board', fresh: true, agrees: true },
      ],
    }));
    await d.recordOutcome(row.id, 'confirmed');
    const stats = await d.sourceAgreement({});
    assert.equal(stats.gps.confirmed, 1);
    assert.equal(stats.board.confirmed, 1);
  });

test('reverted counts as graded-but-not-confirmed, like contradicted',
  { skip: skipWithoutPg() }, async (t) => {
    const { d } = await setup(t);
    const row = await d.recordDecision(base({
      verdict: 'act', confidence: 90, actionKey: 'x',
      sources: [{ source: 'gps', fresh: true, agrees: true }],
    }));
    await d.recordOutcome(row.id, 'reverted');
    const stats = await d.sourceAgreement({});
    assert.deepEqual(stats.gps, { graded: 1, confirmed: 0 },
      'both mean the outcome did not bear it out, and the caller cannot act on '
      + 'a distinction between them');
  });

test('a decision with no sources contributes nothing and breaks nothing',
  { skip: skipWithoutPg() }, async (t) => {
    const { d } = await setup(t);
    const row = await d.recordDecision(base({
      verdict: 'act', confidence: 90, actionKey: 'x', sources: [],
    }));
    await d.recordOutcome(row.id, 'confirmed');
    assert.deepEqual(await d.sourceAgreement({}), {});
  });

test('"NOTHING KNOWS HOW TO VERIFY THIS" IS NOT EVIDENCE AGAINST A SOURCE',
  { skip: skipWithoutPg() }, async (t) => {
    // The `hold` / `unknown` distinction, one layer down and applied to
    // outcomes. `not_checked` means no verifier exists for that action — an
    // honest answer, per the outcomes module's own header — and counting it as
    // graded-but-unconfirmed turned it into evidence AGAINST the source.
    //
    // It was not hypothetical. Five of the seven actions that can run have no
    // verifier, so each recorded `not_checked`; at five of them a check's
    // source crossed MIN_GRADED at 0% agreement, `soleSourceIsUnreliable`
    // fired — the correction seam cites exactly one source — and every later
    // correction from that check would have been held for ever. Automatic
    // repair would have stopped across most of the fleet, quietly, hours after
    // it was wired up.
    const { d } = await setup(t);
    for (const subjectId of ['A', 'B', 'C', 'D', 'E']) {
      // eslint-disable-next-line no-await-in-loop
      const row = await d.recordDecision(base({
        subjectId, verdict: 'act', confidence: 90, actionKey: 'unverifiable',
        sources: [{ source: 'check:home_time.returned_to_road', fresh: true, agrees: true }],
      }));
      // eslint-disable-next-line no-await-in-loop
      await d.recordOutcome(row.id, 'not_checked', 'nothing knows how to verify it');
    }

    const stats = await d.sourceAgreement({});
    assert.deepEqual(stats, {},
      'five unverifiable actions say nothing at all about the check that took them');

    // And the consequence that matters: the source stays unmeasured, so it
    // costs the next correction nothing.
    // eslint-disable-next-line global-require
    const { reliabilityOf } = require('../lib/decisions/sources');
    assert.deepEqual(
      reliabilityOf(stats['check:home_time.returned_to_road']),
      { known: false, graded: 0, agreementRate: null, poor: false }
    );
  });

test('an expired outcome is not a verdict on the source either',
  { skip: skipWithoutPg() }, async (t) => {
    // "The subject is gone, or too much time has passed to judge" is an absence
    // of information, not information against.
    const { d } = await setup(t);
    const row = await d.recordDecision(base({
      verdict: 'act', confidence: 90, actionKey: 'x',
      sources: [{ source: 'gps', fresh: true, agrees: true }],
    }));
    await d.recordOutcome(row.id, 'expired');
    assert.deepEqual(await d.sourceAgreement({}), {});
  });

test('and a real judgement still counts, so the model is not merely switched off',
  { skip: skipWithoutPg() }, async (t) => {
    const { d } = await setup(t);
    const graded = await d.recordDecision(base({
      subjectId: 'real', verdict: 'act', confidence: 90, actionKey: 'x',
      sources: [{ source: 'gps', fresh: true, agrees: true }],
    }));
    await d.recordOutcome(graded.id, 'contradicted');
    const skipped = await d.recordDecision(base({
      subjectId: 'skipped', verdict: 'act', confidence: 90, actionKey: 'y',
      sources: [{ source: 'gps', fresh: true, agrees: true }],
    }));
    await d.recordOutcome(skipped.id, 'not_checked');

    assert.deepEqual((await d.sourceAgreement({})).gps, { graded: 1, confirmed: 0 },
      'the one that was actually judged is the one that counts');
  });
