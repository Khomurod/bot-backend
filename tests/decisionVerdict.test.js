'use strict';

/**
 * The four answers, and the two that look alike and are opposites.
 *
 * This file holds three properties. `hold` AND `unknown` ARE NEVER CONFLATED —
 * evidence against and evidence absent call for opposite actions. A MODE CAN
 * ONLY NARROW — a switch in an admin panel is permission to act on evidence
 * that already supports acting, never evidence itself. And DISAGREEMENT IS A
 * QUESTION, not a vote to be won by the more confident side.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  VERDICTS, MODES, assessEvidence, applyMode, decide,
} = require('../lib/decisions/verdict');

const fresh = (source, agrees = true) => ({ source, at: '2026-09-11T10:00:00Z', fresh: true, agrees });
const stale = (source, agrees = true) => ({ source, at: '2026-09-01T10:00:00Z', fresh: false, agrees });

// ── unknown is not low confidence ───────────────────────────────────────────

test('nothing read at all is UNKNOWN, and carries no confidence', () => {
  const out = assessEvidence({ sources: [], confidence: 95 });
  assert.equal(out.verdict, VERDICTS.UNKNOWN);
  assert.equal(out.confidence, null,
    'a confidence attached to "I do not know" is a number somebody compares '
    + 'against a threshold');
});

test('EVERYTHING STALE IS UNKNOWN, NEVER HOLD', () => {
  const out = assessEvidence({ sources: [stale('samsara'), stale('eld')], confidence: 90 });
  assert.equal(out.verdict, VERDICTS.UNKNOWN);
  assert.match(out.reason, /stale/);
  assert.notEqual(out.verdict, VERDICTS.HOLD,
    'a truck nobody has heard from is not a truck standing still — that '
    + 'conflation is how a dead feed becomes an inactivity report');
});

test('a rule that reached no confidence is UNKNOWN, not zero', () => {
  const out = assessEvidence({ sources: [fresh('board')], confidence: null });
  assert.equal(out.verdict, VERDICTS.UNKNOWN);
  assert.equal(out.confidence, null);
});

test('evidence AGAINST is hold, and it is a real answer with a real score', () => {
  const out = assessEvidence({ sources: [fresh('gps', false)], confidence: 90 });
  assert.equal(out.verdict, VERDICTS.HOLD);
});

test('low confidence is HOLD and keeps its number — it knew, it just knew weakly', () => {
  const out = assessEvidence({ sources: [fresh('gps')], confidence: 40, minConfidence: 70 });
  assert.equal(out.verdict, VERDICTS.HOLD);
  assert.equal(out.confidence, 40, 'unlike unknown, this one has something to report');
});

// ── disagreement is a question ──────────────────────────────────────────────

test('SOURCES THAT DISAGREE PRODUCE HOLD, never the more confident side', () => {
  const out = assessEvidence({
    sources: [fresh('board', true), fresh('gps', false)], confidence: 99,
  });
  assert.equal(out.verdict, VERDICTS.HOLD);
  assert.match(out.reason, /disagree/);
  assert.match(out.reason, /gps/, 'and it names which one dissented');
});

test('a source with NO opinion is not a dissenter', () => {
  const out = assessEvidence({
    sources: [fresh('board', true), { source: 'eld', fresh: true, agrees: null }],
    confidence: 90,
  });
  assert.equal(out.verdict, VERDICTS.ACT, 'silence is not disagreement');
});

// ── a mode can only narrow ──────────────────────────────────────────────────

test('AUTOPILOT CANNOT TURN unknown INTO act', () => {
  const out = decide({ sources: [], confidence: 99, mode: MODES.AUTOPILOT });
  assert.equal(out.verdict, VERDICTS.UNKNOWN,
    'a switch in an admin panel is permission to act on evidence that already '
    + 'supports acting; it is not evidence');
});

test('autopilot cannot turn hold into act either', () => {
  const out = decide({ sources: [fresh('gps', false)], confidence: 99, mode: MODES.AUTOPILOT });
  assert.equal(out.verdict, VERDICTS.HOLD);
});

test('observe turns a perfectly good act into hold, and says why', () => {
  const out = decide({ sources: [fresh('gps')], confidence: 95, mode: MODES.OBSERVE });
  assert.equal(out.verdict, VERDICTS.HOLD);
  assert.match(out.reason, /Observe/);
});

test('suggest is the default for an unrecognised mode, never autopilot', () => {
  const out = decide({ sources: [fresh('gps')], confidence: 95, mode: 'turbo' });
  assert.equal(out.verdict, VERDICTS.SUGGEST);
  assert.equal(out.mode, MODES.SUGGEST,
    'an unreadable setting must fail to the cautious side');
});

test('autopilot on good evidence acts', () => {
  const out = decide({ sources: [fresh('gps')], confidence: 95, mode: MODES.AUTOPILOT });
  assert.equal(out.verdict, VERDICTS.ACT);
});

// ── the line AI may not cross ───────────────────────────────────────────────

test('NO PARAMETER EXISTS THROUGH WHICH A MODEL COULD DECIDE THIS', () => {
  // The same assertion `evaluateSuspension` carries in the policy watcher, for
  // the same reason: the guarantee is worth more as a signature than as a
  // sentence in a comment somebody edits later.
  // Read the signature itself. `Function.length` is 0 here (a defaulted
  // parameter does not count), so the surface is checked where it is declared.
  const signature = assessEvidence.toString().slice(0, assessEvidence.toString().indexOf('{', 40));
  const accepted = ['sources', 'confidence', 'minConfidence'];
  for (const key of accepted) {
    assert.ok(signature.includes(key), `${key} is part of the evidence surface`);
  }
  for (const forbidden of ['ai', 'model', 'llm', 'override', 'suggestion']) {
    assert.equal(new RegExp(forbidden, 'i').test(signature), false,
      `\`${forbidden}\` must not be a way into this decision`);
  }
  const probe = assessEvidence({
    sources: [fresh('gps')], confidence: 95,
    // Every one of these is ignored, because none of them is evidence.
    aiVerdict: 'act', aiConfidence: 100, modelSays: 'go', override: true,
  });
  assert.equal(probe.verdict, VERDICTS.ACT);
  const forced = assessEvidence({
    sources: [], aiVerdict: 'act', aiConfidence: 100, override: true,
  });
  assert.equal(forced.verdict, VERDICTS.UNKNOWN,
    'with no sources it is unknown however loudly a model disagrees');
  assert.ok(accepted.length === 3);
});

test('a verdict is plain data — it cannot do anything', () => {
  const out = decide({ sources: [fresh('gps')], confidence: 95, mode: MODES.AUTOPILOT });
  for (const v of Object.values(out)) assert.notEqual(typeof v, 'function');
  assert.equal(JSON.stringify(out).includes('function'), false);
});

test('applyMode leaves a non-act verdict alone but records the mode in force', () => {
  const held = { verdict: VERDICTS.HOLD, confidence: 20, reason: 'because' };
  const out = applyMode(held, MODES.AUTOPILOT);
  assert.equal(out.verdict, VERDICTS.HOLD);
  assert.equal(out.mode, MODES.AUTOPILOT,
    'the mode AT THE TIME is recorded even when it changed nothing, so reading '
    + 'the decision back later does not rewrite it through today\'s setting');
});
