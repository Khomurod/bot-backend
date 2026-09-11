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

const { takeDecision } = require('../services/decisions/journal');

function harness() {
  const written = [];
  const deps = {
    decisions: {
      async recordDecision(row) { written.push(row); return { id: 7, ...row }; },
    },
  };
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
