'use strict';

/**
 * When Wenze may put something back, and — far more often — when it may not.
 *
 * THE STATE THIS REPLACES. Verification could reach exactly one contradiction:
 * a value that no longer matches what we wrote. It could not tell who changed
 * it, so it said `someone` and refused. The machinery was complete and
 * unreachable — the only contradiction it could detect was the one it must
 * never undo — and `autoRevert` was false on every action as a result.
 *
 * The rules below are the whole feature. Most of them are refusals, and that is
 * the correct shape: an automatic undo is a second unattended write on top of
 * the first, and the cases where that is safer than telling somebody are rare
 * and have to be proven one at a time.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ORIGINS, VERDICTS, IMPACT_CLASSES, AUTO_REVERTABLE_IMPACT,
  classifyOrigin, assessRollback,
} = require('../lib/decisions/rollbackSafety');

const CONTRADICTED = { outcome: 'contradicted', fields: ['status'], detail: 'status changed' };
const INTACT = { outcome: 'confirmed', fields: [], detail: 'still there' };
const GONE = { holds: false, reason: 'the driver has been on the road since Tuesday' };
const HOLDS = { holds: true, reason: 'still at home' };
const SAFE_ACTION = { autoRevert: true, impact: 'operational' };

// ── where did the change come from ─────────────────────────────────────────

test('an admin action after ours is a human override', () => {
  const o = classifyOrigin({ laterAudits: [{ adminId: 3 }] });
  assert.equal(o.origin, ORIGINS.HUMAN);
});

test('a later correction by a person is a human override', () => {
  const o = classifyOrigin({ laterCorrections: [{ initiator: 'admin:7' }] });
  assert.equal(o.origin, ORIGINS.HUMAN);
  assert.match(o.detail, /admin:7/);
});

test('a later correction by the system is the system', () => {
  const o = classifyOrigin({ laterCorrections: [{ initiator: 'system' }] });
  assert.equal(o.origin, ORIGINS.SYSTEM);
});

/**
 * THE COMMON CASE, and it must not read like a clean bill of health. The audit
 * trail does not cover every write path in this application, so finding nothing
 * is genuinely "we do not know" rather than "nobody did it".
 */
test('nothing in the trail is UNKNOWN, not innocent', () => {
  const o = classifyOrigin({});
  assert.equal(o.origin, ORIGINS.UNKNOWN);
  assert.match(o.detail, /origin is unknown/);
});

// ── the refusals ───────────────────────────────────────────────────────────

test('A PERSON CHANGING IT IS NEVER UNDONE', () => {
  const r = assessRollback({
    comparison: CONTRADICTED,
    origin: classifyOrigin({ laterCorrections: [{ initiator: 'admin:7' }] }),
    action: SAFE_ACTION,
  });
  assert.equal(r.rollBack, false);
  assert.equal(r.verdict, VERDICTS.HUMAN_OVERRIDE);
  assert.match(r.why, /arguing with them/);
});

test('AN UNEXPLAINED CHANGE IS NEVER UNDONE', () => {
  const r = assessRollback({
    comparison: CONTRADICTED, origin: classifyOrigin({}), action: SAFE_ACTION,
  });
  assert.equal(r.rollBack, false);
  assert.equal(r.verdict, VERDICTS.UNKNOWN_ORIGIN);
});

test('another automatic correction moving it is a fight, not a rollback', () => {
  const r = assessRollback({
    comparison: CONTRADICTED,
    origin: classifyOrigin({ laterCorrections: [{ initiator: 'system' }] }),
    action: SAFE_ACTION,
  });
  assert.equal(r.rollBack, false);
  assert.equal(r.verdict, VERDICTS.NEEDS_REVIEW);
  assert.match(r.why, /set the two fighting/);
});

/** The whole point of the impact class: a flag cannot buy its way past this. */
test('EMPLOYMENT, PAY, DISCIPLINE AND COMPLIANCE ARE NEVER UNDONE AUTOMATICALLY', () => {
  for (const impact of IMPACT_CLASSES.filter((i) => i !== AUTO_REVERTABLE_IMPACT)) {
    const r = assessRollback({
      comparison: INTACT, stillJustified: GONE,
      action: { autoRevert: true, impact },  // declared safe, and still refused
    });
    assert.equal(r.rollBack, false, `${impact} must never auto-revert`);
    assert.equal(r.verdict, VERDICTS.NEEDS_REVIEW);
    assert.match(r.why, new RegExp(impact));
  }
});

test('an action with no impact class declared is refused, not assumed harmless', () => {
  const r = assessRollback({
    comparison: INTACT, stillJustified: GONE, action: { autoRevert: true },
  });
  assert.equal(r.rollBack, false);
  assert.match(r.why, /unclassified/);
});

test('an operational action that has not opted in is still not undone', () => {
  const r = assessRollback({
    comparison: INTACT, stillJustified: GONE,
    action: { autoRevert: false, impact: 'operational' },
  });
  assert.equal(r.rollBack, false);
  assert.match(r.why, /not declared safe/);
});

test('OSCILLATION IS PREVENTED — one put-back, then a person', () => {
  const r = assessRollback({
    comparison: INTACT, stillJustified: GONE, action: SAFE_ACTION, priorReverts: 1,
  });
  assert.equal(r.rollBack, false);
  assert.equal(r.verdict, VERDICTS.NEEDS_REVIEW);
  assert.match(r.why, /already been put back/);
});

test('a second revert of the same correction is refused', () => {
  const r = assessRollback({
    comparison: INTACT, stillJustified: GONE, action: SAFE_ACTION, alreadyReverted: true,
  });
  assert.equal(r.rollBack, false);
});

test('a vanished subject is a review item, never an undo', () => {
  const r = assessRollback({
    comparison: { outcome: 'expired' }, stillJustified: GONE, action: SAFE_ACTION,
  });
  assert.equal(r.rollBack, false);
  assert.equal(r.verdict, VERDICTS.NEEDS_REVIEW);
});

test('an unverifiable action is a review item, never a confirmation', () => {
  const r = assessRollback({ comparison: { outcome: 'not_checked' }, action: SAFE_ACTION });
  assert.equal(r.verdict, VERDICTS.NEEDS_REVIEW);
});

// ── the confirmations ──────────────────────────────────────────────────────

test('values intact and evidence holding is verified correct', () => {
  const r = assessRollback({ comparison: INTACT, stillJustified: HOLDS, action: SAFE_ACTION });
  assert.equal(r.verdict, VERDICTS.VERIFIED);
  assert.equal(r.rollBack, false);
});

/** An action with no evidence re-read claims only what it can see. */
test('with no evidence re-read declared, "still there" is all that is claimed', () => {
  const r = assessRollback({ comparison: INTACT, action: SAFE_ACTION });
  assert.equal(r.verdict, VERDICTS.VERIFIED);
  assert.match(r.why, /still in place/);
});

// ── the one case that actually reverts ─────────────────────────────────────

/**
 * Values untouched, nobody involved, and the operational evidence that
 * justified the write is no longer true. This is the case automatic rollback
 * was built for, and — before this module — the one case it could not see.
 */
test('THE REASON EVAPORATING, ON A LOW-RISK REVERSIBLE ACTION, IS AN UNDO', () => {
  const r = assessRollback({
    comparison: INTACT, stillJustified: GONE, action: SAFE_ACTION, priorReverts: 0,
  });
  assert.equal(r.rollBack, true);
  assert.equal(r.verdict, VERDICTS.REVERTED);
  assert.match(r.why, /on the road since Tuesday/, 'and it says exactly what changed its mind');
});
