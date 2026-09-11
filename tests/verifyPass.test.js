'use strict';

/**
 * The pass that goes back and grades what was done.
 *
 * WITHOUT THIS, THE TRACK RECORD IS DECORATION. `lib/decisions/sources.js`
 * decides what a source is worth from how often decisions citing it were later
 * confirmed. Nothing else ever sets an outcome, so with no verification pass
 * every source stays unmeasured for ever and the reliability model — and the
 * floor built on it — never does anything.
 *
 * The pass grades from LIVE rows. A decision that graded its own homework would
 * be worth nothing while LOOKING like a track record, which is worse than none.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { runVerificationPass, SUBJECTS } = require('../services/decisions/verifyPass');

function harness({ due = [], corrections = {}, rows = {} } = {}) {
  const graded = [];
  const reverted = [];
  const deps = {
    decisions: {
      async listUnverifiedActions() { return due; },
      async recordOutcome(id, outcome, detail) { graded.push({ id, outcome, detail }); return true; },
    },
    corrections: {
      async revertCorrection(args) { reverted.push(args); return { reverted: true }; },
    },
  };
  const client = {
    async query(sql, params) {
      if (/operational_corrections/.test(sql)) {
        const row = corrections[params[0]];
        return { rows: row ? [row] : [] };
      }
      const row = rows[String(params[0])];
      return { rows: row ? [row] : [] };
    },
    release() {},
  };
  const db = { pool: { async connect() { return client; } } };
  return { deps, db, graded, reverted };
}

const decision = (over = {}) => ({
  id: 1, checkKey: 'home_time.closable_open_cycle', actionKey: 'home_time.close_cycle',
  subjectId: '55', correctionId: 900, ...over,
});

test('a value still in place is graded CONFIRMED', async () => {
  const { deps, db, graded } = harness({
    due: [decision()],
    corrections: { 900: { id: 900, subject_id: '55', new_values: { return_to_road_at: '2026-09-01T10:00:00Z' }, reverted_at: null } },
    rows: { 55: { return_to_road_at: '2026-09-01T10:00:00Z', home_days: 3 } },
  });
  const out = await runVerificationPass({ db, deps });
  assert.equal(out.confirmed, 1);
  assert.equal(graded[0].outcome, 'confirmed');
});

test('A PERSON HAVING CHANGED IT IS CONTRADICTED, AND NOT UNDONE', async () => {
  const { deps, db, graded, reverted } = harness({
    due: [decision()],
    corrections: { 900: { id: 900, subject_id: '55', new_values: { return_to_road_at: '2026-09-01T10:00:00Z' }, reverted_at: null } },
    rows: { 55: { return_to_road_at: '2026-09-05T10:00:00Z' } },
  });
  const out = await runVerificationPass({ db, deps });
  assert.equal(out.contradicted, 1);
  assert.equal(out.rolledBack, 0);
  assert.deepEqual(reverted, [],
    'undoing it would mean software and a person taking turns overwriting each '
    + 'other, and the software wins because it never gets bored');
  assert.equal(graded[0].outcome, 'contradicted');
});

test('an action nothing knows how to verify is NOT_CHECKED, never confirmed', async () => {
  const { deps, db, graded } = harness({ due: [decision({ actionKey: 'something.new' })] });
  const out = await runVerificationPass({ db, deps });
  assert.equal(out.notChecked, 1);
  assert.equal(graded[0].outcome, 'not_checked');
  assert.match(graded[0].detail, /nothing knows how to verify/);
});

test('a decision whose correction has vanished is NOT_CHECKED', async () => {
  const { deps, db, graded } = harness({ due: [decision()], corrections: {} });
  const out = await runVerificationPass({ db, deps });
  assert.equal(out.notChecked, 1);
  assert.match(graded[0].detail, /correction this decision points at is gone/);
});

test('a vanished subject row is EXPIRED', async () => {
  const { deps, db } = harness({
    due: [decision()],
    corrections: { 900: { id: 900, subject_id: '55', new_values: { return_to_road_at: 'x' }, reverted_at: null } },
    rows: {},
  });
  const out = await runVerificationPass({ db, deps });
  assert.equal(out.expired, 1);
});

test('NO ACTION IS DECLARED SAFE TO UNDO AUTOMATICALLY — a decision, not an oversight', () => {
  const declared = Object.entries(SUBJECTS).filter(([, s]) => s.autoRevert === true);
  assert.deepEqual(declared, [],
    'every action here changes operational state about a real driver, and an '
    + 'automatic undo is a second unattended write on top of the first. The '
    + 'machinery is built and tested; turning one on should be somebody\'s '
    + 'deliberate decision');
});

test('AND NO ROLLBACK CAN FIRE TODAY, whatever a subject declares', async () => {
  // Arming the registry entry proves the point rather than undermining it: the
  // only contradiction this pass can DETECT is "a person changed it", and that
  // one is refused regardless of what the action declares.
  const original = SUBJECTS['home_time.close_cycle'].autoRevert;
  Object.defineProperty(SUBJECTS['home_time.close_cycle'], 'autoRevert',
    { value: true, configurable: true });
  try {
    const { deps, db, reverted, graded } = harness({
      due: [decision()],
      corrections: {
        900: {
          id: 900, subject_id: '55',
          new_values: { return_to_road_at: '2026-09-01T10:00:00Z' }, reverted_at: null,
        },
      },
      rows: { 55: { return_to_road_at: '2026-09-05T10:00:00Z' } },
    });
    const out = await runVerificationPass({ db, deps });
    assert.equal(out.contradicted, 1);
    assert.equal(out.rolledBack, 0);
    assert.deepEqual(reverted, [],
      'the guard refuses a change a person may have made, even for an action '
      + 'that has opted into automatic rollback');
    assert.equal(graded[0].outcome, 'contradicted');
  } finally {
    Object.defineProperty(SUBJECTS['home_time.close_cycle'], 'autoRevert',
      { value: original, configurable: true });
  }
});

test('nothing due is a skip, not a failure', async () => {
  const { deps, db } = harness({ due: [] });
  const out = await runVerificationPass({ db, deps });
  assert.equal(out.skipped, 'nothing to verify');
  assert.equal(out.checked, 0);
});

test('NO DATABASE IS BLOCKED, not quietly graded from memory', async () => {
  const { deps } = harness({ due: [decision()] });
  const out = await runVerificationPass({ db: null, deps });
  assert.equal(out.blocked, 'no database');
  assert.equal(out.checked, 0,
    'grading anything from the decision\'s own memory is the one thing this '
    + 'module exists to avoid');
});

test('one subject throwing does not abandon the rest of the pass', async () => {
  const { deps, db } = harness({
    due: [decision({ id: 1 }), decision({ id: 2, correctionId: 901 })],
    corrections: {
      900: { id: 900, subject_id: '55', new_values: { return_to_road_at: 'x' }, reverted_at: null },
      901: { id: 901, subject_id: '56', new_values: { return_to_road_at: '2026-09-01T10:00:00Z' }, reverted_at: null },
    },
    rows: { 56: { return_to_road_at: '2026-09-01T10:00:00Z' } },
  });
  deps.decisions.recordOutcome = async (id) => {
    if (id === 1) throw new Error('write failed');
    return true;
  };
  const out = await runVerificationPass({ db, deps });
  assert.equal(out.checked, 2);
  assert.equal(out.errors, 1);
  assert.equal(out.confirmed, 1, 'the second one was still graded');
});

test('a listing failure reports itself rather than looking like a quiet pass', async () => {
  const { db } = harness();
  const deps = {
    decisions: { async listUnverifiedActions() { throw new Error('database is gone'); } },
    corrections: {},
  };
  const out = await runVerificationPass({ db, deps });
  assert.equal(out.error, 'database is gone');
  assert.equal(out.checked, 0);
});
