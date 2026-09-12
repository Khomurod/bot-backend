'use strict';

/**
 * The only writer in the control channel.
 *
 * Its one rule, tested from several directions: an action must be one the
 * question offered. Plus the two outcomes that are easy to get wrong — a
 * correction somebody beat us to, and a journal entry that must exist whether
 * or not the change then succeeded.
 */
const test = require('node:test');
const assert = require('node:assert');

const { executeOffered } = require('../services/control/actions');
const { initiatorFor } = require('../services/operations/corrections/apply');

class FakeStale extends Error {}

function makeDeps(overrides = {}) {
  const calls = { applied: [], dismissed: [], snoozed: [], decisions: [], acted: [] };
  return {
    calls,
    applyCorrection: async (args) => { calls.applied.push(args); return { id: 90 }; },
    StaleCorrectionError: FakeStale,
    findings: {
      dismissFinding: async (id, opts) => { calls.dismissed.push({ id, ...opts }); return { id }; },
      snoozeFinding: async (id, until) => { calls.snoozed.push({ id, until }); return { id }; },
    },
    takeDecision: async (d) => {
      calls.decisions.push(d);
      return { id: 44, acted: async (k, c) => { calls.acted.push([k, c]); return true; } };
    },
    payloadFor: () => ({ personId: 5, unitNumber: '322' }),
    actionForCheck: () => ({ key: 'identity.sync_unit', tier: 'approval' }),
    ...overrides,
  };
}

const QUESTION = {
  findingId: 11,
  offeredActions: [{ key: 'approve' }, { key: 'dismiss' }, { key: 'snooze' }],
};
const FINDING = {
  id: 11, checkKey: 'identity.stale_unit_assignment', subjectType: 'group',
  subjectId: '49', confidence: 90, severity: 'warning', title: 't', evidence: { personId: 5 },
};

test('AN ACTION THE QUESTION DID NOT OFFER IS REFUSED', async () => {
  const deps = makeDeps();
  const got = await executeOffered({
    question: { findingId: 11, offeredActions: [{ key: 'dismiss' }] },
    finding: FINDING,
    intent: { action: 'approve' },
    telegramUserId: '1',
  }, deps);
  assert.strictEqual(got.outcome, 'refused');
  assert.strictEqual(deps.calls.applied.length, 0);
  assert.strictEqual(deps.calls.decisions.length, 0, 'nothing was even journalled');
});

test('an intent with no action at all is refused', async () => {
  const deps = makeDeps();
  const got = await executeOffered({
    question: QUESTION, finding: FINDING, intent: { action: null }, telegramUserId: '1',
  }, deps);
  assert.strictEqual(got.outcome, 'refused');
});

test('approve journals the decision BEFORE it changes anything, and as a suggestion', async () => {
  const deps = makeDeps();
  const got = await executeOffered({
    question: QUESTION, finding: FINDING, intent: { action: 'approve' }, telegramUserId: '2117922421',
  }, deps);
  assert.strictEqual(got.outcome, 'applied');
  assert.strictEqual(deps.calls.decisions.length, 1);
  const decision = deps.calls.decisions[0];
  assert.strictEqual(decision.mode, 'suggest', 'the check is not in autopilot — a person approved one case');
  assert.strictEqual(decision.shadow, false);
  assert.strictEqual(decision.evidence.approvedVia, 'telegram');
  assert.deepStrictEqual(deps.calls.acted[0], ['identity.sync_unit', 90]);
});

test('the correction is attributed to the PERSON, not the system', async () => {
  const deps = makeDeps();
  await executeOffered({
    question: QUESTION, finding: FINDING, intent: { action: 'approve' }, telegramUserId: '2117922421',
  }, deps);
  // `initiatorFor` turns this into `telegram:<id>`, which is what gets an
  // approval-tier action past the schema's system-is-auto-only CHECK.
  assert.strictEqual(deps.calls.applied[0].admin.telegramUserId, '2117922421');
});

test('somebody fixing it first is a success, not an error', async () => {
  const deps = makeDeps({
    applyCorrection: async () => { throw new FakeStale('moved'); },
  });
  const got = await executeOffered({
    question: QUESTION, finding: FINDING, intent: { action: 'approve' }, telegramUserId: '1',
  }, deps);
  assert.strictEqual(got.outcome, 'no_op');
  assert.match(got.message, /fixed it first/i);
});

test('a real failure is reported as a failure and the finding stays open', async () => {
  const deps = makeDeps({
    applyCorrection: async () => { throw new Error('constraint violated'); },
  });
  const got = await executeOffered({
    question: QUESTION, finding: FINDING, intent: { action: 'approve' }, telegramUserId: '1',
  }, deps);
  assert.strictEqual(got.outcome, 'failed');
  assert.match(got.message, /still open/i);
});

test('dismiss records the owner\'s own words as the reason', async () => {
  const deps = makeDeps();
  const got = await executeOffered({
    question: QUESTION, finding: FINDING,
    intent: { action: 'dismiss', reason: 'he moved trucks last week' },
    telegramUserId: '2117922421',
  }, deps);
  assert.strictEqual(got.outcome, 'dismissed');
  assert.strictEqual(deps.calls.dismissed[0].reason, 'he moved trucks last week');
  assert.strictEqual(deps.calls.dismissed[0].dismissedBy, 'telegram:2117922421');
});

test('a bare no still records a reason, because the schema demands one', async () => {
  const deps = makeDeps();
  await executeOffered({
    question: QUESTION, finding: FINDING, intent: { action: 'dismiss', reason: null }, telegramUserId: '1',
  }, deps);
  assert.ok(deps.calls.dismissed[0].reason, 'a dismissal with no reason cannot be reviewed later');
});

test('snooze hides it for a bounded time, never forever', async () => {
  const deps = makeDeps();
  const got = await executeOffered({
    question: QUESTION, finding: FINDING,
    intent: { action: 'snooze', snoozeHours: 72 }, telegramUserId: '1',
  }, deps);
  assert.strictEqual(got.outcome, 'snoozed');
  const hours = (deps.calls.snoozed[0].until - Date.now()) / 3600000;
  assert.ok(hours > 71 && hours < 73, `${hours}`);
});

test('a wild snooze period is clamped rather than obeyed', async () => {
  const deps = makeDeps();
  await executeOffered({
    question: QUESTION, finding: FINDING,
    intent: { action: 'snooze', snoozeHours: 99999 }, telegramUserId: '1',
  }, deps);
  const hours = (deps.calls.snoozed[0].until - Date.now()) / 3600000;
  assert.ok(hours <= 720, `${hours}`);
});

test('approve with nothing registered to do changes nothing', async () => {
  const deps = makeDeps({ actionForCheck: () => null });
  const got = await executeOffered({
    question: QUESTION, finding: FINDING, intent: { action: 'approve' }, telegramUserId: '1',
  }, deps);
  assert.strictEqual(got.outcome, 'refused');
  assert.strictEqual(deps.calls.applied.length, 0);
});

test('approve with no usable payload changes nothing', async () => {
  const deps = makeDeps({ payloadFor: () => null });
  const got = await executeOffered({
    question: QUESTION, finding: FINDING, intent: { action: 'approve' }, telegramUserId: '1',
  }, deps);
  assert.strictEqual(got.outcome, 'refused');
  assert.strictEqual(deps.calls.applied.length, 0);
});

test('AN OPERATOR IS ATTRIBUTED AS A PERSON, NOT AS THE SYSTEM', () => {
  // The schema refuses an approval-tier correction whose initiator is
  // 'system'. Without this branch an owner's "yes" would fall through to
  // 'system' and be refused — the owner would have answered a question Wenze
  // then could not act on.
  assert.strictEqual(initiatorFor({ telegramUserId: '2117922421' }), 'telegram:2117922421');
  assert.strictEqual(initiatorFor({ id: 4 }), 'admin:4');
  assert.strictEqual(initiatorFor(null), 'system');
  assert.strictEqual(initiatorFor({}), 'system');
  // An administrator answering from Telegram is still the administrator.
  assert.strictEqual(initiatorFor({ id: 4, telegramUserId: '9' }), 'admin:4');
});
