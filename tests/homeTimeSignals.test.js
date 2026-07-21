const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hasHomeTimeSignal,
  hasStrongHomeTimeSignal,
  HOME_TIME_SIGNAL_PATTERNS,
  HOME_TIME_STRONG_SIGNAL_PATTERNS,
  HOME_TIME_WEAK_SIGNAL_PATTERNS,
} = require('../services/homeTimeSignals');
const constants = require('../services/homeTimeRequestConstants');

test('broad = strong ∪ weak (no pattern drift)', () => {
  assert.equal(
    HOME_TIME_SIGNAL_PATTERNS.length,
    HOME_TIME_STRONG_SIGNAL_PATTERNS.length + HOME_TIME_WEAK_SIGNAL_PATTERNS.length,
  );
});

test('constants re-exports the same broad detector (back-compat)', () => {
  assert.equal(constants.hasHomeTimeSignal, hasHomeTimeSignal);
});

test('hasHomeTimeSignal keeps its broad behavior (unchanged contract)', () => {
  // Strong wording
  assert.equal(hasHomeTimeSignal('driver wants to go home next week'), true);
  assert.equal(hasHomeTimeSignal('Can he get some home time?'), true);
  assert.equal(hasHomeTimeSignal('he needs a few days off'), true);
  assert.equal(hasHomeTimeSignal('requesting PTO'), true);
  // Soft/weak wording still counts as a broad signal
  assert.equal(hasHomeTimeSignal('heading home for the night'), true);
  assert.equal(hasHomeTimeSignal('he wants to be at the house for a bit'), true);
  // Ordinary chatter never matches
  assert.equal(hasHomeTimeSignal('Rate confirmation issue on this load'), false);
  assert.equal(hasHomeTimeSignal('Where is the BOL?'), false);
  assert.equal(hasHomeTimeSignal(''), false);
  assert.equal(hasHomeTimeSignal(null), false);
});

test('hasStrongHomeTimeSignal fires ONLY on unambiguous time-off wording', () => {
  // Strong: explicit time-off / request wording
  assert.equal(hasStrongHomeTimeSignal('can he get home time from Jul 2 to Jul 8?'), true);
  assert.equal(hasStrongHomeTimeSignal('he needs a couple days off'), true);
  assert.equal(hasStrongHomeTimeSignal('requesting PTO'), true);
  assert.equal(hasStrongHomeTimeSignal('going on vacation next week'), true);
  assert.equal(hasStrongHomeTimeSignal('please send me home for a few days'), true);
  assert.equal(hasStrongHomeTimeSignal('driver wants to go home'), true);
  assert.equal(hasStrongHomeTimeSignal('home for a week starting Monday'), true);
});

test('hasStrongHomeTimeSignal does NOT fire on incidental / soft "home" mentions', () => {
  assert.equal(hasStrongHomeTimeSignal('almost home boss'), false);
  assert.equal(hasStrongHomeTimeSignal('heading home for the night'), false);
  assert.equal(hasStrongHomeTimeSignal('just got home to the yard'), false);
  assert.equal(hasStrongHomeTimeSignal('picking up parts at Home Depot'), false);
  assert.equal(hasStrongHomeTimeSignal('he is at the house'), false);
  assert.equal(hasStrongHomeTimeSignal('home 20 miles out'), false);
  assert.equal(hasStrongHomeTimeSignal('Rate confirmation issue on this load'), false);
  assert.equal(hasStrongHomeTimeSignal(''), false);
});
