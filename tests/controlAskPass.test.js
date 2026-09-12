'use strict';

/**
 * What gets asked, and — more importantly — what does not.
 *
 * The four noise guards are the substance of this file: the cap, the repeat
 * window, the tier rule, and the wording allow-list. A control channel that
 * asks forty questions a pass ends with the group muted, which is the same
 * silence this whole feature exists to remove.
 */
const test = require('node:test');
const assert = require('node:assert');

const { runAskPass, isAskableFinding, askRoundFor, questionKeyFor } = require('../services/control/askPass');
const { noticeKeyFor } = require('../lib/notifications/compose');

function finding(over = {}) {
  return {
    id: 11, checkKey: 'identity.stale_unit_assignment', status: 'open', tier: 'auto',
    subjectType: 'group', subjectId: '49', confidence: 90, severity: 'warning',
    title: 'Truck on the profile does not match', evidence: { personId: 5 },
    firstSeenAt: new Date(Date.now() - 3600_000).toISOString(),
    ...over,
  };
}

function makeDeps(over = {}) {
  const calls = { notified: [], decisions: [] };
  return {
    calls,
    findings: { listFindings: async () => [finding()] },
    notices: { noticeSentWithin: async () => false, countUnansweredQuestions: async () => 0 },
    settings: {
      getControlSettings: async () => ({
        enabled: true, maxQuestionsPerPass: 5, repeatAfterHours: 72, clarifyLimit: 1,
      }),
    },
    notify: async (n) => { calls.notified.push(n); return { recorded: true }; },
    actionForCheck: () => ({ key: 'identity.sync_unit', tier: 'auto' }),
    payloadFor: () => ({ personId: 5, unitNumber: '322' }),
    loadCheckSettings: async () => new Map([['identity.stale_unit_assignment', { mode: 'suggest' }]]),
    takeDecision: async (d) => { calls.decisions.push(d); return { id: 44 }; },
    ...over,
  };
}

test('a suggest-mode auto finding with an action is asked about', async () => {
  const deps = makeDeps();
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 1);
  const n = deps.calls.notified[0];
  assert.match(n.title, /\?$/);
  assert.strictEqual(n.subjectType, 'control_question');
  assert.strictEqual(n.findingId, 11);
  assert.deepStrictEqual(
    n.question.offeredActions.map((o) => o.key), ['approve', 'dismiss', 'snooze']
  );
});

test('THE VISIBLE TEXT NEVER NAMES AN ACTION', async () => {
  const deps = makeDeps();
  await runAskPass({}, deps);
  const n = deps.calls.notified[0];
  const visible = [n.title, ...(n.lines || []), n.action].join(' ');
  assert.ok(!visible.includes('identity.sync_unit'), visible);
  assert.ok(!/approve|dismiss|snooze/.test(visible), visible);
});

test('a check already in autopilot is not asked about — it just does it', async () => {
  const deps = makeDeps({
    loadCheckSettings: async () => new Map([['identity.stale_unit_assignment', { mode: 'autopilot' }]]),
  });
  assert.strictEqual((await runAskPass({}, deps)).asked, 0);
});

test('a warning-tier finding is never a question — there is nothing to approve', async () => {
  const deps = makeDeps({ findings: { listFindings: async () => [finding({ tier: 'warning' })] } });
  assert.strictEqual((await runAskPass({}, deps)).asked, 0);
});

test('an approval-tier finding IS asked about, whatever the mode', async () => {
  const deps = makeDeps({
    findings: { listFindings: async () => [finding({ tier: 'approval' })] },
    loadCheckSettings: async () => new Map(),
  });
  assert.strictEqual((await runAskPass({}, deps)).asked, 1);
});

test('a check with no question wording never asks', async () => {
  const deps = makeDeps({
    findings: { listFindings: async () => [finding({ checkKey: 'something.invented' })] },
    loadCheckSettings: async () => new Map([['something.invented', { mode: 'suggest' }]]),
  });
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 0);
  assert.strictEqual(got.skipped.noWording, 1);
});

test('THE CAP HOLDS, and the oldest are asked first', async () => {
  const many = Array.from({ length: 12 }, (_, i) => finding({
    id: 100 + i,
    firstSeenAt: new Date(Date.now() - (i + 1) * 86400_000).toISOString(),
  }));
  const deps = makeDeps({
    findings: { listFindings: async () => many },
    settings: {
      getControlSettings: async () => ({
        enabled: true, maxQuestionsPerPass: 3, repeatAfterHours: 72, clarifyLimit: 1,
      }),
    },
  });
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 3);
  // 111 is the oldest (12 days), then 110, then 109.
  assert.deepStrictEqual(deps.calls.notified.map((n) => n.findingId), [111, 110, 109]);
});

test('the same question is not repeated inside the window', async () => {
  const deps = makeDeps({
    notices: { noticeSentWithin: async () => true, countUnansweredQuestions: async () => 0 },
  });
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 0);
  assert.strictEqual(got.skipped.recentlyAsked, 1);
});

test('A FAILED SUPPRESSION READ MEANS SILENCE, NOT A SECOND QUESTION', async () => {
  const deps = makeDeps({
    notices: {
      noticeSentWithin: async () => { throw new Error('down'); },
      countUnansweredQuestions: async () => 0,
    },
  });
  assert.strictEqual((await runAskPass({}, deps)).asked, 0);
});

test('switched off asks nothing at all', async () => {
  const deps = makeDeps({ settings: { getControlSettings: async () => ({ enabled: false }) } });
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 0);
  assert.strictEqual(got.reason, 'disabled');
  assert.strictEqual(deps.calls.notified.length, 0);
});

test('THE SUGGESTION IS JOURNALLED — this is what finally writes suggest rows', async () => {
  const deps = makeDeps();
  await runAskPass({}, deps);
  assert.strictEqual(deps.calls.decisions.length, 1);
  assert.strictEqual(deps.calls.decisions[0].mode, 'suggest');
  assert.strictEqual(deps.calls.decisions[0].shadow, false);
  assert.strictEqual(deps.calls.notified[0].question.decisionId, 44);
});

test('the suppression prefix is the key notify actually writes, and is unambiguous', () => {
  const real = noticeKeyFor('needs_attention', 'control_question', '42', 'r0');
  assert.ok(real.startsWith(questionKeyFor(42)));
  // Finding 4 must not suppress finding 42.
  assert.ok(!real.startsWith(questionKeyFor(4)));
});

test('a re-ask after the window gets a key of its own', () => {
  const first = new Date(Date.now() - 200 * 3600_000).toISOString();
  assert.strictEqual(askRoundFor({ firstSeenAt: first }, 72), 2);
  assert.strictEqual(askRoundFor({ firstSeenAt: new Date().toISOString() }, 72), 0);
  assert.strictEqual(askRoundFor({}, 72), 0, 'no first-seen is round zero, not a crash');
});

test('the askable rule, stated once and read here', () => {
  assert.strictEqual(isAskableFinding(finding(), { mode: 'suggest', hasAction: true }), true);
  assert.strictEqual(isAskableFinding(finding(), { mode: 'autopilot', hasAction: true }), false);
  assert.strictEqual(isAskableFinding(finding(), { mode: 'suggest', hasAction: false }), false);
  assert.strictEqual(isAskableFinding(finding({ tier: 'approval' }), { mode: null, hasAction: true }), true);
  assert.strictEqual(isAskableFinding(finding({ status: 'dismissed' }), { mode: 'suggest', hasAction: true }), false);
});

test('THE STANDING CAP: nothing new is asked while the owner is still answering', async () => {
  // The per-pass cap limits one pass; this sweep runs every fifteen minutes.
  // Without this guard the first day after a deploy delivers hundreds of
  // questions into a group that has answered none of them.
  const deps = makeDeps({
    notices: { noticeSentWithin: async () => false, countUnansweredQuestions: async () => 5 },
  });
  const got = await runAskPass({}, deps);
  assert.strictEqual(got.asked, 0);
  assert.strictEqual(got.reason, 'waiting_for_answers');
  assert.strictEqual(deps.calls.notified.length, 0);
});

test('the standing cap counts against the per-pass cap, not beside it', async () => {
  const many = Array.from({ length: 6 }, (_, i) => finding({ id: 200 + i }));
  const deps = makeDeps({
    findings: { listFindings: async () => many },
    notices: { noticeSentWithin: async () => false, countUnansweredQuestions: async () => 3 },
  });
  // Three already out, five allowed: room for two more, not five.
  assert.strictEqual((await runAskPass({}, deps)).asked, 2);
});

test('A FAILED OUTSTANDING COUNT MEANS SILENCE, not permission to ask more', async () => {
  const deps = makeDeps({
    notices: {
      noticeSentWithin: async () => false,
      countUnansweredQuestions: async () => { throw new Error('down'); },
    },
  });
  assert.strictEqual((await runAskPass({}, deps)).asked, 0);
});
