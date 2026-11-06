'use strict';

/**
 * "No limit — one at a time to Telegram" (owner, 6 November 2026): no daily
 * limit, one unanswered question at a time, the next asked shortly after an
 * answer, and never two passes at once.
 */
const test = require('node:test');
const assert = require('node:assert');

const { runAskPass } = require('../services/control/askPass');
const { finding, makeDeps } = require('./helpers/askPassFixtures');

test('no daily limit, one at a time: the standing cap decides, and a pass already running is not doubled', async () => {
  const many = Array.from({ length: 4 }, (_, i) => finding({ id: 300 + i }));
  const oneAtATime = {
    getControlSettings: async () => ({
      enabled: true, maxQuestionsPerPass: 1, repeatAfterHours: 72, clarifyLimit: 1, maxQuestionsPerDay: null,
    }),
  };
  const deps = makeDeps({ findings: { listAskCandidates: async () => many }, settings: oneAtATime });
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 1, 'one question out at a time');

  const waiting = makeDeps({
    findings: { listAskCandidates: async () => many },
    settings: oneAtATime,
    notices: { noticeSentWithin: async () => false, countUnansweredQuestions: async () => 1 },
  });
  assert.strictEqual((await runAskPass({}, waiting)).asked, 0, 'nothing new while one waits for an answer');

  // Two passes at once (the sweep, and an answer asking the next): the second stands down.
  let release;
  const slow = makeDeps({
    findings: { listAskCandidates: () => new Promise((r) => { release = () => r(many); }) },
    settings: oneAtATime,
  });
  const first = runAskPass({}, slow);
  await new Promise((r) => setImmediate(r));
  const second = await runAskPass({}, makeDeps({ settings: oneAtATime }));
  assert.strictEqual(second.skipped, true);
  release();
  assert.strictEqual((await first).asked, 1);
});

test('an answer asks the next question shortly, once however many answers arrive', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { askNextSoon, cancelAskNext } = require('../services/control/askNext');
  t.after(cancelAskNext);
  let runs = 0;
  const run = async () => { runs += 1; };
  assert.strictEqual(askNextSoon({ delayMs: 1000, run }), true);
  assert.strictEqual(askNextSoon({ delayMs: 1000, run }), false, 'already pending');
  t.mock.timers.tick(1000);
  return new Promise((r) => setImmediate(r)).then(() => assert.strictEqual(runs, 1));
});
