'use strict';

/**
 * Turning "this check keeps being wrong" into a number somebody can agree to.
 *
 * WHAT THIS REPLACES. The learning pass could already say a check's decisions
 * were not holding up, and its advice about the confidence floor was a
 * paragraph: "what that number should be is a judgement about how much caution
 * you want". True, and useless — an administrator cannot agree with a
 * paragraph, nothing became a setting, and the same advice reappeared weekly.
 *
 * THE DIRECTION IS THE SAFETY PROPERTY. A proposal may only ever ask for MORE
 * caution. A check that looks too strict is still reported, with no action
 * attached, because loosening a safety margin on the strength of the machine's
 * own report card is the one shape nobody should build.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { proposeConfidenceFloor } = require('../lib/operations/thresholdProposal');
const { describeThresholdProposal, proposeThresholds } = require('../lib/operations/learning');
const { REGISTRY, ACTIONS, listLearningActions } = require('../services/operations/learningActions');

/** n decisions at `confidence`, of which `held` were later confirmed. */
const rows = (confidence, n, held) => Array.from({ length: n }, (_, i) => ({
  confidence, outcome: i < held ? 'confirmed' : 'contradicted',
}));

const POOR_LOW_GOOD_HIGH = [...rows(72, 6, 2), ...rows(88, 8, 7)];

// ── the arithmetic ─────────────────────────────────────────────────────────

test('the suggested floor is the lowest observed value whose record is good', () => {
  const p = proposeConfidenceFloor({ checkKey: 'identity.sync_unit', graded: POOR_LOW_GOOD_HIGH });
  assert.equal(p.suggestedFloor, 88);
  assert.equal(p.currentFloor, 70, 'null means it inherits the global floor');
  assert.equal(p.currentFloorIsInherited, true);
  assert.equal(p.direction, 'raise');
  assert.equal(p.applicable, true);
});

/**
 * `Number(null)` is 0 and `isFinite(0)` is true, so the first draft read an
 * inherited floor as ZERO — which made every decision count as "at or above the
 * floor" and every candidate look like an improvement. A null check one line
 * too late is not a null check.
 */
test('AN INHERITED FLOOR IS 70, NOT ZERO', () => {
  const p = proposeConfidenceFloor({ checkKey: 'x', graded: POOR_LOW_GOOD_HIGH, currentFloor: null });
  assert.equal(p.currentFloor, 70);
});

test('too little evidence proposes nothing at all', () => {
  assert.equal(proposeConfidenceFloor({ checkKey: 'x', graded: rows(80, 4, 1) }), null);
});

test('a check that already holds up proposes nothing', () => {
  assert.equal(proposeConfidenceFloor({ checkKey: 'x', graded: rows(90, 12, 12) }), null);
});

/** A floor that leaves nothing to act on is a switch-off wearing a threshold. */
test('a floor that would stop the check acting is not proposed as a threshold', () => {
  // Only one decision sits at the high value, so raising to it is not a tuning.
  const p = proposeConfidenceFloor({ checkKey: 'x', graded: [...rows(72, 10, 3), ...rows(95, 1, 1)] });
  assert.equal(p, null, 'disable_auto_apply is the honest action for that');
});

test('the evidence and the expected effect are concrete, not adjectives', () => {
  const p = proposeConfidenceFloor({ checkKey: 'x', graded: POOR_LOW_GOOD_HIGH });
  assert.equal(p.evidence.graded, 14);
  assert.equal(p.evidence.rateAtCurrent, 64);
  assert.equal(p.evidence.rateAtSuggested, 88);
  assert.match(p.expectedEffect, /6 would have been held for a person/);
});

// ── what an administrator sees ─────────────────────────────────────────────

test('the proposal reads as the four lines an administrator can act on', () => {
  const [lesson] = proposeThresholds({ byCheck: { 'identity.sync_unit': POOR_LOW_GOOD_HIGH } });
  assert.equal(lesson.kind, 'threshold_proposal');
  assert.match(lesson.lines[0], /^Current confidence threshold: 70/);
  assert.match(lesson.lines[1], /^Suggested threshold: 88$/);
  assert.match(lesson.lines[2], /^Evidence: /);
  assert.match(lesson.lines[3], /^Expected effect: /);
  assert.equal(lesson.applyAction.action, 'raise_confidence_floor');
  assert.equal(lesson.applyAction.payload.suggestedFloor, 88);
});

/**
 * THE ONE THAT MUST NOT BECOME A BUTTON. Reported, and deliberately inert:
 * accepting it records agreement, and the screen says a person still has to make
 * the change.
 */
test('A PROPOSAL TO LOOSEN A FLOOR CARRIES NO ACTION', () => {
  const lesson = describeThresholdProposal({
    checkKey: 'x', currentFloor: 90, suggestedFloor: null, direction: 'lower',
    currentFloorIsInherited: false, applicable: false,
    evidence: { graded: 20, rateAtCurrent: 95, heldBelowFloor: 12, rateBelowFloor: 91 },
    expectedEffect: 'lots held below the floor',
  });
  assert.equal(lesson.applyAction, null);
  assert.match(lesson.lines[1], /Wenze will not name a number/);
  assert.match(lesson.suggestion, /the change itself is yours to make/);
});

// ── the boundary the action itself enforces ────────────────────────────────

test('the registry action refuses any floor outside 70–95', async () => {
  const action = REGISTRY[ACTIONS.RAISE_CONFIDENCE_FLOOR];
  for (const bad of [10, 69, 96, 100]) {
    await assert.rejects(
      () => action.apply({ checkKey: 'x', suggestedFloor: bad }, { checkSettings: {} }),
      /only ever proposes MORE caution|outside the 70–95/,
      `a floor of ${bad} must be refused before it reaches the database`
    );
  }
});

test('there is still no action anywhere that grants more autonomy', () => {
  for (const key of listLearningActions()) {
    assert.ok(!/enable|grant|allow|turn_on|lower|reduce|weaken/.test(key),
      `${key} — every action here may only ever make Wenze more cautious`);
  }
});

test('applying records what was there, and reverting puts exactly that back', async () => {
  const action = REGISTRY[ACTIONS.RAISE_CONFIDENCE_FLOOR];
  const written = [];
  const deps = {
    actor: 'admin:3',
    checkSettings: {
      async listCheckSettings() { return [{ checkKey: 'x', minConfidence: null }]; },
      async setMinConfidence(key, value) { written.push({ key, value }); },
    },
  };

  const out = await action.apply({ checkKey: 'x', suggestedFloor: 85 }, deps);
  assert.equal(out.changed, 1);
  assert.deepEqual(out.before, { present: true, checkKey: 'x', minConfidence: null });
  assert.deepEqual(written, [{ key: 'x', value: 85 }]);

  await action.revert(out.before, deps);
  assert.deepEqual(written[1], { key: 'x', value: null },
    'back to inheriting the global floor — the value it actually had');
});

test('a floor already at least as cautious is left alone', async () => {
  const action = REGISTRY[ACTIONS.RAISE_CONFIDENCE_FLOOR];
  const written = [];
  const out = await action.apply({ checkKey: 'x', suggestedFloor: 80 }, {
    checkSettings: {
      async listCheckSettings() { return [{ checkKey: 'x', minConfidence: 90 }]; },
      async setMinConfidence(key, value) { written.push({ key, value }); },
    },
  });
  assert.equal(out.changed, 0);
  assert.deepEqual(written, [], 'never a step DOWN, even from an older suggestion');
});
