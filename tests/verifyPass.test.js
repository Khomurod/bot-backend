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
const { IMPACT_CLASSES, AUTO_REVERTABLE_IMPACT } = require('../lib/decisions/rollbackSafety');

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

/**
 * EVERY ACTION DECLARES WHAT IT COULD COST A PERSON.
 *
 * Not a list kept somewhere else — a property on the action itself, so adding
 * one without thinking about its impact fails here rather than inheriting
 * "harmless" by default. This replaces an earlier guard that asserted no action
 * was auto-revertable at all; that was true when the rollback path could not
 * fire, and the rule underneath it is what actually matters.
 */
test('every verifiable action declares an impact class', () => {
  for (const [key, subject] of Object.entries(SUBJECTS)) {
    assert.ok(IMPACT_CLASSES.includes(subject.impact),
      `${key} must declare one of ${IMPACT_CLASSES.join(', ')} — it declared ${subject.impact}`);
  }
});

test('ONLY OPERATIONAL ACTIONS MAY EVER BE UNDONE AUTOMATICALLY', () => {
  for (const [key, subject] of Object.entries(SUBJECTS)) {
    if (subject.autoRevert !== true) continue;
    assert.equal(subject.impact, AUTO_REVERTABLE_IMPACT,
      `${key} is declared auto-revertable but its impact is ${subject.impact}; employment, `
      + 'pay, discipline and compliance are never undone without a person');
  }
});

/**
 * The auto-revertable set, written out. It is EMPTY: the one action that had
 * been argued safe to undo automatically, `board.link_person`, went with the
 * Dispatcher Board in October 2026. Arming another fails this test, which is
 * the point — each one has to be argued beside its entry in `verifyPass.js`.
 */
test('no action is armed to be undone automatically', () => {
  const armed = Object.entries(SUBJECTS).filter(([, s]) => s.autoRevert === true).map(([k]) => k);
  assert.deepEqual(armed, []);
});

/**
 * A FLAG WITH NO EVIDENCE READ BEHIND IT CAN NEVER FIRE. Rollback is reachable
 * only down the "the reason evaporated" path, and that path needs the action's
 * own `stillJustified`. An action declaring `autoRevert` without one would be a
 * dead switch that reads as a live one — the exact shape of defect this
 * repository keeps finding.
 */
test('an action declared auto-revertable also declares how its evidence is re-read', () => {
  for (const [key, subject] of Object.entries(SUBJECTS)) {
    if (subject.autoRevert !== true) continue;
    assert.equal(typeof subject.stillJustified, 'function',
      `${key} can never actually revert without a stillJustified read`);
  }
});

test('A CHANGED VALUE OF UNKNOWN ORIGIN IS NEVER UNDONE, whatever a subject declares', async () => {
  // Arming the registry entry proves the point rather than undermining it. This
  // used to read "no rollback can fire today", which was true while the only
  // detectable contradiction was a changed value. Rollback can fire now — down
  // the "the reason evaporated" path, on an action that declares an evidence
  // re-read — and this case is still refused, because a value someone else
  // moved is never put back when we cannot say who moved it.
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

// ── every action that can be journalled must be verifiable ─────────────────

test('EVERY AUTO-APPLIED ACTION HAS A VERIFIER', () => {
  // Five of seven had none. `verifyOne` answers `not_checked` for those, and
  // `sourceAgreement` used to count that as graded-but-unconfirmed — enough to
  // measure a check at 0% agreement and hold every later correction from it
  // for ever. The query ignores `not_checked` now; this is the other half.
  // eslint-disable-next-line global-require
  const { CHECK_TO_ACTION, actionForCheck } = require('../services/operations/corrections/actions');

  const missing = [];
  for (const checkKey of CHECK_TO_ACTION.keys()) {
    const action = actionForCheck(checkKey);
    // Only actions that can be applied automatically ever reach the journal.
    if (!action || action.tier !== 'auto') continue;
    if (!SUBJECTS[action.key]) missing.push(`${checkKey} -> ${action.key}`);
  }
  assert.deepEqual(missing, [],
    'an auto action with no verifier records not_checked for ever, and can never '
    + 'earn its check a track record');
});

test('A VERIFIER THAT READS THE WRONG COLUMNS WOULD CONFIRM EVERYTHING', () => {
  // `compareWritten` SKIPS a field the row does not carry, so a read with no
  // overlap finds nothing to disagree with and returns CONFIRMED — a false
  // clean bill of health, worse than the `not_checked` it replaced. This pins
  // the shape rather than trusting it.
  // eslint-disable-next-line global-require
  const { compareWritten, OUTCOMES } = require('../lib/decisions/verification');

  assert.equal(
    compareWritten({ wrote: { state: 'road' }, current: { somethingElse: 1 } }).outcome,
    OUTCOMES.CONFIRMED,
    'this is the trap: no overlap reads as confirmed'
  );

  // So each verifier is asserted to select at least one key its action writes.
  const WRITES = {
    'identity.ensure_person': ['personId'],
    'identity.sync_unit': ['unitNumber', 'personId'],
    'home_time.mark_returned_to_road': ['state', 'state_since'],
    'home_time.abandon_exhausted_alerts': ['state', 'requestIds'],
    'home_time.close_cycle': ['return_to_road_at', 'home_days'],
    'identity.sync_profile_status': ['status'],
  };
  for (const [actionKey, fields] of Object.entries(WRITES)) {
    const subject = SUBJECTS[actionKey];
    assert.ok(subject, `${actionKey} has a verifier`);
    const sql = subject.read.toString();
    assert.ok(fields.some((f) => sql.includes(f)),
      `${actionKey}'s read must select at least one of ${fields.join(', ')} — `
      + 'otherwise it confirms everything');
  }
});

test('the abandoned-alert verifier reads the ids from the correction, not the subject', async () => {
  // Its subject is the outbox as a whole; the rows it changed are named only
  // in `new_values.requestIds`, which is why `read` is handed the correction.
  const subject = SUBJECTS['home_time.abandon_exhausted_alerts'];
  const asked = [];
  const client = {
    async query(sql, params) {
      asked.push(params);
      return { rows: [{ total: 3, abandoned: 3 }] };
    },
  };

  const out = await subject.read(client, 'outbox', { new_values: { requestIds: [7, 8, 9] } });
  assert.deepEqual(asked[0][0], [7, 8, 9]);
  assert.equal(out.state, 'abandoned');

  // ONE ROW RESTORED IS THE CONTRADICTION WORTH CATCHING. Reporting the
  // majority would hide it.
  const partial = {
    async query() { return { rows: [{ total: 3, abandoned: 2 }] }; },
  };
  const mixed = await subject.read(partial, 'outbox', { new_values: { requestIds: [7, 8, 9] } });
  assert.equal(mixed.state, 'partly_restored');

  // eslint-disable-next-line global-require
  const { compareWritten, OUTCOMES } = require('../lib/decisions/verification');
  assert.equal(
    compareWritten({ wrote: { state: 'abandoned', requestIds: [7, 8, 9] }, current: mixed }).outcome,
    OUTCOMES.CONTRADICTED
  );
});

test('a correction with no recorded ids is expired, not confirmed', async () => {
  const subject = SUBJECTS['home_time.abandon_exhausted_alerts'];
  const client = { async query() { throw new Error('must not be asked'); } };
  assert.equal(await subject.read(client, 'outbox', { new_values: {} }), null,
    'null means the subject is gone, which compareWritten reports as expired');
});

// ── the path that actually reverts ─────────────────────────────────────────
//
// NO REGISTRY ENTRY IS ARMED TODAY, so the machinery is driven through one that
// is armed for the duration of a test — the same technique the close-cycle case
// above uses. What is proved is the path itself: the values we wrote are
// untouched, nobody has been near them, and the evidence that justified the
// write now says something else.

const ARMED_KEY = 'home_time.mark_returned_to_road';

/** Arm one subject with an evidence re-read for one test, then put it back. */
function armed(t, stillJustified) {
  const subject = SUBJECTS[ARMED_KEY];
  const saved = {
    autoRevert: subject.autoRevert, stillJustified: subject.stillJustified, read: subject.read,
  };
  const set = (k, v) => Object.defineProperty(subject, k, { value: v, configurable: true, writable: true });
  set('autoRevert', true);
  set('stillJustified', stillJustified);
  set('read', async () => ({ state: 'road', state_since: '2026-09-10T00:00:00Z' }));
  t.after(() => { for (const [k, v] of Object.entries(saved)) set(k, v); });
}

/** A client that answers the reads the evidence path makes, dispatched by what each asks. */
function evidenceClient({ priorReverts = 0, laterBy = null }) {
  const correction = {
    id: 900, subject_id: '55', subject_type: 'group',
    action_key: ARMED_KEY, applied_at: '2026-09-10T00:00:00Z', reverted_at: null,
    new_values: { state: 'road', state_since: '2026-09-10T00:00:00Z' },
  };
  return {
    async query(sql) {
      if (/FROM operational_corrections WHERE id/.test(sql)) return { rows: [correction] };
      if (/COUNT\(\*\)::int AS n FROM operational_corrections/.test(sql)) {
        return { rows: [{ n: priorReverts }] };
      }
      if (/SELECT initiator FROM operational_corrections/.test(sql)) {
        return { rows: laterBy ? [{ initiator: laterBy }] : [] };
      }
      return { rows: [] };
    },
    release() {},
  };
}

function evidenceHarness(opts = {}) {
  const graded = [];
  const reverted = [];
  const client = evidenceClient(opts);
  return {
    graded,
    reverted,
    db: { pool: { async connect() { return client; } } },
    deps: {
      decisions: {
        async listUnverifiedActions() {
          return [{
            id: 1, checkKey: 'home_time.returned_to_road', actionKey: ARMED_KEY,
            subjectId: '55', correctionId: 900,
          }];
        },
        async recordOutcome(id, outcome, detail) { graded.push({ id, outcome, detail }); return true; },
      },
      corrections: {
        async revertCorrection(args) { reverted.push(args); return { reverted: true }; },
      },
    },
  };
}

const GONE = async () => ({ holds: false, reason: 'the truck has not moved since, so the driver is not back on the road' });
const HOLDS = async () => ({ holds: true, reason: 'the truck is still moving' });

test('EVIDENCE THAT NO LONGER HOLDS UNDOES THE WRITE, and says why', async (t) => {
  armed(t, GONE);
  const { db, deps, reverted, graded } = evidenceHarness();
  const out = await runVerificationPass({ db, deps });

  assert.equal(out.rolledBack, 1, 'the write is put back');
  assert.equal(reverted.length, 1);
  assert.match(reverted[0].reason, /automatic rollback/);
  assert.match(reverted[0].reason, /has not moved since/, 'the audit row carries the evidence that changed its mind');
  assert.equal(graded[0].outcome, 'reverted');
  assert.match(graded[0].detail, /\[automatically_reverted\]/);
});

test('evidence that still holds is simply verified', async (t) => {
  armed(t, HOLDS);
  const { db, deps, reverted, graded } = evidenceHarness();
  const out = await runVerificationPass({ db, deps });
  assert.equal(out.rolledBack, 0);
  assert.deepEqual(reverted, []);
  assert.match(graded[0].detail, /\[verified_correct\]/);
});

/** Oscillation: once is a correction, twice is two systems arguing. */
test('a subject already put back once is left for a person', async (t) => {
  armed(t, GONE);
  const { db, deps, reverted, graded } = evidenceHarness({ priorReverts: 1 });
  const out = await runVerificationPass({ db, deps });
  assert.equal(out.rolledBack, 0);
  assert.deepEqual(reverted, []);
  assert.match(graded[0].detail, /\[requires_human_review\]/);
  assert.match(graded[0].detail, /already been put back/);
});

test('after the pass, nothing is left armed', () => {
  assert.notEqual(SUBJECTS[ARMED_KEY].autoRevert, true);
});
