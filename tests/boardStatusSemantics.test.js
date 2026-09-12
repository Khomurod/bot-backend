'use strict';

/**
 * What a board status means to Wenze.
 *
 * These words feed CONTRADICTIONS, so a wrong mapping does not produce a wrong
 * correction — it produces a false accusation that two systems disagree, and
 * somebody spends an afternoon on it. The tests are therefore mostly about the
 * words that mean NEITHER thing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  boardSaysHome, boardSaysWorking, boardHasOpinion, describeBoardStatus,
  HOME_STATUSES, WORKING_STATUSES, NEUTRAL_STATUSES,
} = require('../lib/board/statusSemantics');
const { KNOWN_STATUSES } = require('../lib/board/parse');

test('HOME and VACATION mean the driver is not working', () => {
  for (const s of HOME_STATUSES) {
    assert.equal(boardSaysHome(s), true, s);
    assert.equal(boardSaysWorking(s), false, s);
  }
});

test('DISPATCHED and ENROUTE mean the driver is on the road', () => {
  for (const s of WORKING_STATUSES) {
    assert.equal(boardSaysWorking(s), true, s);
    assert.equal(boardSaysHome(s), false, s);
  }
});

test('NEUTRAL IS NEITHER — a resting driver is not contradicting anything', () => {
  // The temptation is to fold REST and SHOP into "not home, therefore working".
  // That is how a driver legitimately resting gets reported as contradicting
  // their own home-time record.
  for (const s of NEUTRAL_STATUSES) {
    assert.equal(boardSaysHome(s), false, s);
    assert.equal(boardSaysWorking(s), false, s);
    assert.equal(boardHasOpinion(s), false, s);
    assert.equal(describeBoardStatus(s), 'neutral', s);
  }
});

test('a word the board invents tomorrow is never a conclusion', () => {
  for (const s of ['DETAINED', 'OUT OF SERVICE', 'xyz', '', null, undefined, 123]) {
    assert.equal(boardSaysHome(s), false, String(s));
    assert.equal(boardSaysWorking(s), false, String(s));
    assert.equal(describeBoardStatus(s), 'unknown', String(s));
  }
});

test('every status the parser knows is placed somewhere', () => {
  // A status in the parser's vocabulary with no meaning here would fall through
  // to `unknown` and silently stop producing contradictions.
  for (const s of KNOWN_STATUSES) {
    assert.notEqual(describeBoardStatus(s), 'unknown', `${s} has no meaning assigned`);
  }
});

test('the three groups do not overlap', () => {
  const all = [...HOME_STATUSES, ...WORKING_STATUSES, ...NEUTRAL_STATUSES];
  assert.equal(new Set(all).size, all.length);
});

test('case and whitespace do not change the answer', () => {
  assert.equal(boardSaysHome(' home '), true);
  assert.equal(boardSaysWorking('enroute'), true);
});
