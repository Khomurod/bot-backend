'use strict';

/**
 * Deciding and recording are ONE call, and this file is why.
 *
 * Every defect this project has fixed had one shape: two things that should
 * agree, kept in step by nobody. A decide-then-remember-to-journal pair would
 * become that within a month, and it would fail in the worst direction — the
 * holds and the "I do not know yet"s are the decisions a caller has no other
 * reason to write down, and they are precisely the ones outcome learning needs.
 *
 * So the tests here are mostly about what a CALLER cannot get wrong.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { takeDecision, clearReliabilityCache } = require('../services/decisions/journal');

function harness({ agreement = {} } = {}) {
  const written = [];
  const deps = {
    decisions: {
      async recordDecision(row) { written.push(row); return { id: 7, ...row }; },
      async sourceAgreement() { return agreement; },
    },
  };
  clearReliabilityCache();
  return { deps, written };
}

const fresh = (source, agrees = true) => ({ source, fresh: true, agrees });

const ask = (over = {}) => ({
  checkKey: 'load_lifecycle.conflict', subjectType: 'load', subjectId: '9001',
  sources: [fresh('gps')], confidence: 95, minConfidence: 70, mode: 'autopilot',
  ...over,
});

test('a decision that changes nothing is STILL recorded', async () => {
  const { deps, written } = harness();
  const out = await takeDecision(ask({ sources: [], confidence: null }), deps);
  assert.equal(out.verdict, 'unknown');
  assert.equal(written.length, 1,
    'the decisions nobody would otherwise write down are the ones this exists for');
});

test('MAY-ACT IS TRUE FOR EXACTLY ONE VERDICT IN ONE MODE', async () => {
  const { deps } = harness();
  const cases = [
    [{ mode: 'autopilot' }, true],
    [{ mode: 'suggest' }, false],
    [{ mode: 'observe' }, false],
    [{ mode: 'autopilot', sources: [] }, false],
    [{ mode: 'autopilot', sources: [fresh('gps', false)] }, false],
    [{ mode: 'autopilot', confidence: 10 }, false],
    [{ mode: 'autopilot', shadow: true }, false],
  ];
  for (const [over, expected] of cases) {
    // eslint-disable-next-line no-await-in-loop
    const out = await takeDecision(ask(over), deps);
    assert.equal(out.mayAct, expected, `${JSON.stringify(over)} → mayAct ${expected}`);
  }
});

test('SHADOW NEVER ACTS, however good the evidence', async () => {
  const { deps, written } = harness();
  const out = await takeDecision(ask({ shadow: true, wouldHave: { action: 'close_cycle' } }), deps);
  assert.equal(out.verdict, 'act', 'the evidence was good and that is recorded honestly');
  assert.equal(out.mayAct, false, 'and it still does nothing');
  assert.deepEqual(written[0].wouldHave, { action: 'close_cycle' });
});

test('a shadow decision that would NOT have acted records no would-have', async () => {
  const { deps, written } = harness();
  await takeDecision(ask({ shadow: true, confidence: 10 }), deps);
  assert.equal(written[0].wouldHave, null,
    '"it would have held" is not a plan anybody needs to compare against');
});

test('the mode IN FORCE is recorded, not the verdict\'s wish', async () => {
  const { deps, written } = harness();
  await takeDecision(ask({ mode: 'observe' }), deps);
  assert.equal(written[0].mode, 'observe');
  assert.equal(written[0].verdict, 'hold');
});

test('an unknown verdict is recorded with no confidence', async () => {
  const { deps, written } = harness();
  await takeDecision(ask({ sources: [] }), deps);
  assert.equal(written[0].verdict, 'unknown');
  assert.equal(written[0].confidence, null);
});

test('acting is recorded separately, because the action can still fail', async () => {
  const { deps, written } = harness();
  const out = await takeDecision(ask(), deps);
  assert.equal(written.length, 1);
  assert.equal(written[0].actionKey, undefined);
  await out.acted('close_cycle', 42);
  assert.equal(written.length, 2);
  assert.equal(written[1].actionKey, 'close_cycle');
  assert.equal(written[1].correctionId, 42);
});

test('A JOURNAL FAILURE NEVER BREAKS THE PASS IT OBSERVES', async () => {
  const deps = {
    decisions: { async recordDecision() { throw new Error('database is gone'); } },
  };
  const out = await takeDecision(ask(), deps);
  assert.equal(out.verdict, 'act', 'the decision still stands');
  assert.equal(out.mayAct, true, 'and the caller may still act on it');
  assert.equal(out.id, null, 'it simply was not written down');
  assert.equal(await out.acted('close_cycle'), false);
});

test('the sources travel with the decision, so it can be re-read later', async () => {
  const { deps, written } = harness();
  await takeDecision(ask({ sources: [fresh('gps'), fresh('board')] }), deps);
  assert.equal(written[0].sources.length, 2);
  assert.deepEqual(written[0].sources.map((s) => s.source), ['gps', 'board']);
});

test('a decision is data — nothing in what is WRITTEN can act', async () => {
  const { deps, written } = harness();
  await takeDecision(ask(), deps);
  for (const v of Object.values(written[0])) assert.notEqual(typeof v, 'function');
});

// ── what the evidence is worth, measured rather than assumed ────────────────

test('A MEASURED-POOR SOURCE ALONE CANNOT CARRY AN ACTION', async () => {
  // The threshold is deliberately LOW here. With a normal 70 the confidence
  // penalty alone would already have held this, and the test would pass
  // without the floor existing at all — proving nothing about it. At 30 the
  // weighed confidence (99 − 25 poor − 10 uncorroborated = 64) clears the bar,
  // so only the floor can produce a hold.
  const { deps, written } = harness({ agreement: { flaky: { graded: 20, confirmed: 4 } } });
  const out = await takeDecision(
    ask({ sources: [fresh('flaky')], confidence: 99, minConfidence: 30 }), deps
  );
  assert.equal(out.verdict, 'hold',
    'when the only thing speaking for an action is a source we have measured as '
    + 'usually wrong, that is an absence of evidence, not weak evidence — and '
    + 'an absence cannot be lowered into acceptability by a generous threshold');
  assert.equal(out.mayAct, false);
  assert.match(written[0].reason, /measured as usually wrong/);
});

test('and the penalty alone also holds it at an ordinary threshold', async () => {
  // The two mechanisms agree in the common case; the one above is where they
  // do not, which is the case worth having a floor for.
  const { deps } = harness({ agreement: { flaky: { graded: 20, confirmed: 4 } } });
  const out = await takeDecision(ask({ sources: [fresh('flaky')], confidence: 99 }), deps);
  assert.equal(out.verdict, 'hold');
});

test('the same poor source is fine as one voice among several', async () => {
  const { deps } = harness({ agreement: { flaky: { graded: 20, confirmed: 4 } } });
  const out = await takeDecision(
    ask({ sources: [fresh('flaky'), fresh('gps')], confidence: 99 }), deps
  );
  assert.equal(out.verdict, 'act');
});

test('AN UNMEASURED SOURCE IS NOT DISCOUNTED', async () => {
  const { deps } = harness({ agreement: { newish: { graded: 2, confirmed: 0 } } });
  const out = await takeDecision(ask({ sources: [fresh('newish')], confidence: 95 }), deps);
  assert.equal(out.verdict, 'act',
    'nought for two is a bad week, not a bad source — and "never checked" must '
    + 'not be punished like "checked and wrong"');
});

test('a stale reading lowers the confidence that gets recorded', async () => {
  const { deps, written } = harness();
  await takeDecision(ask({
    sources: [
      { source: 'a', fresh: false, agrees: true },
      { source: 'b', fresh: true, agrees: true },
    ],
    confidence: 90,
  }), deps);
  assert.equal(written[0].confidence, 70, 'half the readings stale, half the penalty');
});

test('THE WEIGHING\'S REASONS TRAVEL WITH THE DECISION', async () => {
  const { deps, written } = harness();
  await takeDecision(ask({
    sources: [{ source: 'a', fresh: false, agrees: true }, fresh('b')],
    confidence: 90,
  }), deps);
  assert.ok(Array.isArray(written[0].evidence.weighing));
  assert.match(written[0].evidence.weighing.join(' '), /stale/,
    'a decision read back months later must say why its confidence was what it '
    + 'was, not only what it was');
});

test('a decision with nothing to explain carries no weighing noise', async () => {
  const { deps, written } = harness();
  await takeDecision(ask({ sources: [fresh('a'), fresh('b')], confidence: 90 }), deps);
  assert.equal(written[0].evidence.weighing, undefined);
});

test('weighing can never RAISE the confidence a rule reached', async () => {
  const { deps, written } = harness({ agreement: { gps: { graded: 50, confirmed: 50 } } });
  await takeDecision(ask({
    sources: [fresh('gps'), fresh('board'), fresh('eld')], confidence: 75,
  }), deps);
  assert.equal(written[0].confidence, 75);
});

test('a reliability lookup that throws costs no source anything', async () => {
  const { written } = harness();
  const deps = {
    decisions: {
      async recordDecision(row) { written.push(row); return { id: 7, ...row }; },
      async sourceAgreement() { throw new Error('database is gone'); },
    },
  };
  clearReliabilityCache();
  const out = await takeDecision(ask({ sources: [fresh('gps')], confidence: 95 }), deps);
  assert.equal(out.verdict, 'act',
    'failing closed here would quietly discount every source in the application '
    + 'the first time that query broke');
});
