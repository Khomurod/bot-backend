'use strict';

/**
 * Proposing a change to Wenze's own rules, and never making one.
 *
 * The line this file holds: NOTHING HERE CAN APPLY ANYTHING. A suggestion is a
 * row at `proposed` and a message. Important business rules must not change
 * permanently without an administrator confirming, and the enforcement is that
 * the code which spots the pattern has no way to act on it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const pass = require('../services/operations/learningPass');

const NOW = Date.parse('2026-09-11T00:00:00Z');
const ago = (days) => new Date(NOW - days * 86400000).toISOString();

const revert = (over = {}) => ({
  actionKey: 'home_time.close_cycle',
  checkKey: 'home_time.closable_open_cycle',
  subjectType: 'road_history', subjectId: 1,
  revertedAt: ago(2), revertedBy: 'boss', revertReason: 'wrong return date',
  ...over,
});

function harness({
  corrections = [], conversations = [], stored = null,
  correctionsThrow = false, conversationsThrow = false,
} = {}) {
  const calls = { notified: [], upserts: [], marked: [] };
  const deps = {
    corrections: {
      async listCorrections(args) {
        if (correctionsThrow) throw new Error('database down');
        calls.listArgs = args;
        return corrections;
      },
    },
    conversations: {
      async listConversations() {
        if (conversationsThrow) throw new Error('database down');
        return conversations;
      },
    },
    store: {
      async upsertSuggestion(row) { calls.upserts.push(row); return { id: 1, status: 'proposed', ...stored, ...row }; },
      async markSuggestionNotified(id) { calls.marked.push(id); return {}; },
    },
    async notify(n) { calls.notified.push(n); return { recorded: true, delivered: true }; },
  };
  return { deps, calls };
}

const THREE = [1, 2, 3].map((id) => revert({ subjectId: id }));

test('one revert proposes nothing', async () => {
  const { deps, calls } = harness({ corrections: [revert()] });
  const summary = await pass.runLearningPass({ now: NOW, deps });
  assert.equal(summary.found, 0);
  assert.deepEqual(calls.notified, []);
});

test('three of the same action is when it becomes worth saying', async () => {
  const { deps, calls } = harness({ corrections: THREE });
  const summary = await pass.runLearningPass({ now: NOW, deps });
  assert.equal(summary.found, 1);
  assert.equal(summary.announced, 1);
  assert.equal(calls.notified[0].category, 'ai_learning');
  assert.match(calls.notified[0].title, /undone 3 times/);
});

test('THE NOTICE SAYS PLAINLY THAT NOTHING HAS CHANGED', async () => {
  const { deps, calls } = harness({ corrections: THREE });
  await pass.runLearningPass({ now: NOW, deps });
  assert.match(calls.notified[0].action, /Nothing has changed/);
  assert.match(calls.notified[0].action, /accept or dismiss/);
});

test('the suggestion is stored as PROPOSED, and there is no code path that applies it', async () => {
  const { deps, calls } = harness({ corrections: THREE });
  await pass.runLearningPass({ now: NOW, deps });
  // Nothing was passed that could execute: a title, a sentence and evidence.
  assert.deepEqual(
    Object.keys(calls.upserts[0]).sort(),
    ['evidence', 'kind', 'subjectId', 'suggestion', 'title'],
  );
  const src = require('node:fs').readFileSync(
    require.resolve('../services/operations/learningPass'), 'utf8'
  );
  for (const forbidden of ['updateCheckSettings', 'setCheckEnabled', 'applyCorrection', 'upsertProvider']) {
    assert.ok(!src.includes(forbidden), `a learning pass must never call ${forbidden}`);
  }
});

test('a suggestion already announced is not announced again', async () => {
  const { deps, calls } = harness({
    corrections: THREE, stored: { notifiedAt: '2026-09-10T00:00:00Z' },
  });
  const summary = await pass.runLearningPass({ now: NOW, deps });
  assert.equal(summary.proposed, 1, 'the row is still refreshed, so the screen stays current');
  assert.equal(summary.announced, 0);
  assert.deepEqual(calls.notified, []);
});

test('a suggestion somebody DISMISSED is not raised again', async () => {
  const { deps, calls } = harness({ corrections: THREE, stored: { status: 'dismissed' } });
  const summary = await pass.runLearningPass({ now: NOW, deps });
  assert.equal(summary.announced, 0);
  assert.deepEqual(calls.notified, [], 'meeting a dismissed proposal every fortnight is how somebody stops reading them');
});

test('nor one already accepted', async () => {
  const { deps, calls } = harness({ corrections: THREE, stored: { status: 'accepted' } });
  await pass.runLearningPass({ now: NOW, deps });
  assert.deepEqual(calls.notified, []);
});

test('only REVERTED corrections are read — one nobody objected to is not feedback', async () => {
  const { deps, calls } = harness({ corrections: THREE });
  await pass.runLearningPass({ now: NOW, deps });
  assert.equal(calls.listArgs.live, false, 'live: false is the reverted ones');
});

test('repeated recruiting refusals for an unapproved figure read as a GAP in what Wenze was taught', async () => {
  const { deps, calls } = harness({
    conversations: [
      { driverPhone: '+1', refusals: 2, updatedAt: ago(1), lastRefusalReason: 'unapproved_figure — used 92' },
      { driverPhone: '+2', refusals: 2, updatedAt: ago(2), lastRefusalReason: 'unapproved_figure — used 85' },
    ],
  });
  await pass.runLearningPass({ now: NOW, deps });
  assert.match(calls.notified[0].reason, /Teach Wenze/);
});

test('half the evidence is still evidence — one source failing does not lose the other', async () => {
  const { deps, calls } = harness({ corrections: THREE, conversationsThrow: true });
  const summary = await pass.runLearningPass({ now: NOW, deps });
  assert.equal(summary.found, 1);
  assert.equal(calls.notified.length, 1);
});

test('both sources failing is a quiet pass, not a crash and not a false all-clear', async () => {
  const { deps, calls } = harness({ correctionsThrow: true, conversationsThrow: true });
  const summary = await pass.runLearningPass({ now: NOW, deps });
  assert.equal(summary.found, 0);
  assert.deepEqual(calls.notified, []);
});

test('a failure storing one suggestion costs that one only', async () => {
  const corrections = [
    ...THREE,
    ...[4, 5, 6].map((id) => revert({ actionKey: 'identity.sync_status', subjectId: id })),
  ];
  const { deps, calls } = harness({ corrections });
  let first = true;
  const original = deps.store.upsertSuggestion;
  deps.store.upsertSuggestion = async (row) => {
    if (first) { first = false; throw new Error('write failed'); }
    return original(row);
  };
  const summary = await pass.runLearningPass({ now: NOW, deps });
  assert.equal(summary.found, 2);
  assert.equal(summary.errors.length, 1);
  assert.equal(calls.notified.length, 1, 'the second was still raised');
});

test('the pass runs twice a day, not hourly — a proposal about behaviour should arrive rarely', () => {
  assert.equal(pass.POLL_MS, 12 * 60 * 60 * 1000);
});
