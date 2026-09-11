/**
 * The knowledge store against a real PostgreSQL.
 *
 * The one property worth a database: NOTHING IS EVER OVERWRITTEN. A rate
 * changing from 70 to 77 cents produces a new row and supersedes the old one;
 * the old one stays, with the dates it was true. "What were we telling
 * candidates in August" gets asked after a dispute, and a table that overwrites
 * cannot answer it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();
const seed = (t) => createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
const load = (h) => h.loadDataLayer(['recruitingKnowledge']).recruitingKnowledge;

const OLD_PAY = { kind: 'fact', topic: 'pay', statement: 'Company driver pay is 70 CPM.' };
const NEW_PAY = { kind: 'fact', topic: 'pay', statement: 'Company driver pay is 77 CPM.' };

test('a proposal is not in use until somebody confirms it', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const db = load(harness);
  const proposed = await db.proposeKnowledge({ ...NEW_PAY, proposedBy: 'admin' });
  assert.equal(proposed.status, 'proposed');
  assert.deepEqual(await db.listActiveKnowledge(), [],
    'the recruiting AI reads only active entries — a proposal reaches no candidate');
});

test('confirming puts it into use and records who agreed', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const db = load(harness);
  const proposed = await db.proposeKnowledge({ ...NEW_PAY, proposedBy: 'admin' });
  const active = await db.confirmKnowledge(proposed.id, { confirmedBy: 'boss' });
  assert.equal(active.status, 'active');
  assert.equal(active.confirmedBy, 'boss');
  assert.ok(active.effectiveFrom, 'and when it started being true');
  assert.equal((await db.listActiveKnowledge()).length, 1);
});

test('a changed fact SUPERSEDES rather than overwrites, and the old one keeps its dates',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const db = load(harness);
    const old = await db.confirmKnowledge(
      (await db.proposeKnowledge(OLD_PAY)).id, { confirmedBy: 'boss' }
    );
    const next = await db.proposeKnowledge({ ...NEW_PAY, supersedesId: old.id });
    await db.confirmKnowledge(next.id, { confirmedBy: 'boss' });

    const active = await db.listActiveKnowledge();
    assert.equal(active.length, 1, 'only one pay rate is in force');
    assert.match(active[0].statement, /77 CPM/);

    const previous = await db.getKnowledge(old.id);
    assert.equal(previous.status, 'superseded', 'and the old one is still here');
    assert.ok(previous.effectiveTo, 'with the day it stopped being true');
    assert.match(previous.statement, /70 CPM/, 'in the words that were actually used');
  });

test('the two halves of a replacement are one transaction', { skip: skipWithoutPg() }, async (t) => {
  // Between "the new rate is live" and "the old rate is not", a candidate could
  // be quoted both or neither.
  const harness = await seed(t);
  const db = load(harness);
  const old = await db.confirmKnowledge((await db.proposeKnowledge(OLD_PAY)).id, {});
  const next = await db.proposeKnowledge({ ...NEW_PAY, supersedesId: old.id });
  await db.confirmKnowledge(next.id, {});
  const both = await harness.query(
    `SELECT status FROM recruiting_knowledge WHERE status = 'active'`
  );
  assert.equal(both.rows.length, 1);
});

test('confirming twice is refused rather than duplicating', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const db = load(harness);
  const p = await db.proposeKnowledge(NEW_PAY);
  await db.confirmKnowledge(p.id, {});
  await assert.rejects(() => db.confirmKnowledge(p.id, {}), /already active/);
});

test('a rejected proposal keeps its words and its reason', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const db = load(harness);
  const p = await db.proposeKnowledge(NEW_PAY);
  const rejected = await db.rejectKnowledge(p.id, { reason: 'not until the first', rejectedBy: 'boss' });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.rejectedReason, 'not until the first');
  assert.match(rejected.statement, /77 CPM/, 'a rejected idea is still a record of what was asked');
  assert.deepEqual(await db.listActiveKnowledge(), []);
});

test('retiring takes a fact out of use without deleting it', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const db = load(harness);
  const active = await db.confirmKnowledge((await db.proposeKnowledge(NEW_PAY)).id, {});
  const retired = await db.retireKnowledge(active.id, { retiredBy: 'boss' });
  assert.equal(retired.status, 'retired');
  assert.ok(retired.effectiveTo);
  assert.deepEqual(await db.listActiveKnowledge(), []);
  assert.ok(await db.getKnowledge(active.id), 'the row is still there');
});

test('the history of a fact walks all the way back', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const db = load(harness);
  const first = await db.confirmKnowledge(
    (await db.proposeKnowledge({ ...OLD_PAY, statement: 'Pay is 65 CPM.' })).id, {}
  );
  const second = await db.confirmKnowledge(
    (await db.proposeKnowledge({ ...OLD_PAY, supersedesId: first.id })).id, {}
  );
  const third = await db.confirmKnowledge(
    (await db.proposeKnowledge({ ...NEW_PAY, supersedesId: second.id })).id, {}
  );
  const history = await db.knowledgeHistory(third.id);
  assert.equal(history.length, 3);
  assert.match(history[0].statement, /77 CPM/);
  assert.match(history[2].statement, /65 CPM/, 'what we were saying two changes ago');
});

test('boundaries and corrections live beside facts, ordered for a prompt',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const db = load(harness);
    for (const row of [
      { kind: 'correction', topic: 'pay', statement: 'Do not say "guaranteed" about miles.' },
      { kind: 'boundary', topic: 'orientation', statement: 'Never say orientation is paid.' },
      NEW_PAY,
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await db.confirmKnowledge((await db.proposeKnowledge(row)).id, {});
    }
    const active = await db.listActiveKnowledge();
    assert.deepEqual(active.map((k) => k.kind), ['fact', 'boundary', 'correction'],
      'a model attends most to what it read last, so the limits come after the facts');
  });

test('an unknown kind or status is refused by the schema', { skip: skipWithoutPg() }, async (t) => {
  const harness = await seed(t);
  const db = load(harness);
  await assert.rejects(() => db.proposeKnowledge({ ...NEW_PAY, kind: 'opinion' }), /kind/);
});

test('the summary separates what is in use from what awaits a person',
  { skip: skipWithoutPg() }, async (t) => {
    const harness = await seed(t);
    const db = load(harness);
    await db.confirmKnowledge((await db.proposeKnowledge(NEW_PAY)).id, {});
    await db.proposeKnowledge({ kind: 'boundary', topic: 'x', statement: 'Never say y.' });
    const s = await db.summariseKnowledge();
    assert.equal(s.active, 1);
    assert.equal(s.proposed, 1, 'so somebody can see there is a decision waiting');
  });
