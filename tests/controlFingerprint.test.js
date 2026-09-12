'use strict';

/**
 * A memory that is too broad silences a real problem; one that is too narrow
 * never matches and the feature quietly does nothing. Both failures look like
 * success from the outside, so each is proved here by what it refuses.
 */
const test = require('node:test');
const assert = require('node:assert');

const {
  CONDITION_FIELDS, ACTS_FROM_MEMORY, isRememberable, stable,
  fingerprintFor, memoryApplies, actsFromMemory,
} = require('../lib/control/fingerprint');
const { QUESTIONS } = require('../lib/control/askable');

const FINDING = {
  checkKey: 'board.truck_disagrees_with_profile',
  subjectType: 'group',
  subjectId: 49,
  evidence: { groupId: 49, personId: 8, profileUnit: '310', boardTruck: '311', boardSeenAt: '2026-09-12T10:00:00Z' },
};

function memoryFor(finding, patch = {}) {
  return {
    id: 1,
    checkKey: finding.checkKey,
    subjectType: finding.subjectType,
    subjectId: String(finding.subjectId),
    answerAction: 'dismiss',
    answerText: 'He swapped trucks this morning.',
    evidenceFingerprint: fingerprintFor(finding),
    revokedAt: null,
    expiresAt: null,
    ...patch,
  };
}

test('the same condition fingerprints the same, whatever moved around it', () => {
  const later = {
    ...FINDING,
    // A NEW FINDING ROW, a new sweep, a new timestamp — the situation is the
    // same one the owner looked at.
    evidence: { ...FINDING.evidence, boardSeenAt: '2026-09-14T02:00:00Z', groupName: 'renamed' },
  };
  assert.strictEqual(fingerprintFor(FINDING), fingerprintFor(later));
});

test('A CHANGED CONDITION IS A NEW QUESTION', () => {
  const moved = { ...FINDING, evidence: { ...FINDING.evidence, boardTruck: '404' } };
  assert.notStrictEqual(fingerprintFor(FINDING), fingerprintFor(moved));
});

test('12 and "12" are the same truck; 007 and 7 are not', () => {
  assert.strictEqual(stable(12), stable('12'));
  assert.strictEqual(stable(' 12 '), '12');
  // Leading zeros are part of a unit number. Normalising them away would make
  // unit 007 and unit 7 one condition, and one driver's answer would settle
  // another driver's finding.
  assert.notStrictEqual(stable('007'), stable('7'));
});

test('an object hashes the same whichever order its keys were built in', () => {
  assert.strictEqual(stable({ a: 1, b: 2 }), stable({ b: 2, a: 1 }));
});

test('a check nobody listed is NOT rememberable — it is asked every time', () => {
  assert.strictEqual(isRememberable('something.brand_new'), false);
  assert.strictEqual(fingerprintFor({ checkKey: 'something.brand_new', evidence: {} }), null);
});

test('every rememberable check is one Wenze actually asks about', () => {
  // A fingerprint for a check that never asks is dead code pretending to be a
  // safety rule; the two lists are meant to stay in step.
  for (const key of Object.keys(CONDITION_FIELDS)) {
    assert.ok(QUESTIONS[key], `${key} has condition fields but no question wording`);
  }
});

test('no condition field list is empty — that would hash every situation alike', () => {
  for (const [key, fields] of Object.entries(CONDITION_FIELDS)) {
    assert.ok(Array.isArray(fields) && fields.length > 0, `${key} defines no condition`);
  }
});

test('a memory applies only to its own subject AND its own condition', () => {
  assert.strictEqual(memoryApplies(FINDING, memoryFor(FINDING)), true);

  // Same condition, different driver.
  const otherDriver = { ...FINDING, subjectId: 50 };
  assert.strictEqual(memoryApplies(otherDriver, memoryFor(FINDING)), false);

  // Same driver, different condition.
  const newProblem = { ...FINDING, evidence: { ...FINDING.evidence, boardTruck: '999' } };
  assert.strictEqual(memoryApplies(newProblem, memoryFor(FINDING)), false);
});

test('a revoked or expired memory does nothing', () => {
  const now = new Date('2026-09-12T12:00:00Z');
  assert.strictEqual(
    memoryApplies(FINDING, memoryFor(FINDING, { revokedAt: '2026-09-11T00:00:00Z' }), now), false
  );
  assert.strictEqual(
    memoryApplies(FINDING, memoryFor(FINDING, { expiresAt: '2026-09-12T11:59:00Z' }), now), false
  );
  assert.strictEqual(
    memoryApplies(FINDING, memoryFor(FINDING, { expiresAt: '2026-09-13T00:00:00Z' }), now), true
  );
});

test('A REMEMBERED YES IS NEVER ACTED ON — this is the side door that stays shut', () => {
  assert.deepStrictEqual([...ACTS_FROM_MEMORY], ['dismiss']);
  assert.strictEqual(actsFromMemory('approve'), false);
  assert.strictEqual(actsFromMemory('snooze'), false);
  assert.strictEqual(actsFromMemory('dismiss'), true);
});

test('the fingerprint is a hash, not the evidence — nothing readable leaks into it', () => {
  const fp = fingerprintFor(FINDING);
  assert.match(fp, /^[0-9a-f]{32}$/);
  assert.ok(!fp.includes('310') && !fp.includes('311'));
});
