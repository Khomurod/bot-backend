'use strict';

/**
 * What Wenze remembers, against the real schema.
 *
 * Three things here exist only in SQL and no stub can prove them:
 *   one memory per condition — the UNIQUE key, so answering twice REPLACES;
 *   a revoked memory cannot be read back by the path that acts on memories;
 *   the closed set of actions is a CHECK, not a JavaScript filter.
 *
 * And one thing that is not SQL at all but is the point of the feature: a
 * finding the owner already answered is CLOSED by the ask pass instead of being
 * asked again — and only while the condition is the one they answered about.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { fingerprintFor } = require('../lib/control/fingerprint');

const ALL_MIGRATIONS = allMigrationsSql();

const FINDING = {
  id: 1,
  checkKey: 'board.truck_disagrees_with_profile',
  subjectType: 'group',
  subjectId: 49,
  status: 'open',
  tier: 'approval',
  evidence: { profileUnit: '310', boardTruck: '311', boardSeenAt: '2026-09-12T10:00:00Z' },
};

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const loaded = h.loadDataLayer(['controlKnowledge']);
  return { h, ...loaded };
}

function answer(patch = {}) {
  return {
    checkKey: FINDING.checkKey,
    subjectType: FINDING.subjectType,
    subjectId: String(FINDING.subjectId),
    answerAction: 'dismiss',
    answerText: 'He swapped trucks this morning.',
    evidenceFingerprint: fingerprintFor(FINDING),
    confirmedBy: 'telegram:2117922421',
    ...patch,
  };
}

test('an answer is stored against the condition, and read back', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { controlKnowledge } = await setup(t);
  const saved = await controlKnowledge.rememberAnswer(answer());
  assert.equal(saved.answerAction, 'dismiss');
  assert.equal(saved.timesApplied, 0);
  assert.equal(saved.evidenceFingerprint, fingerprintFor(FINDING));

  const found = await controlKnowledge.findMemory({
    checkKey: FINDING.checkKey, subjectType: 'group', subjectId: '49',
  });
  assert.equal(found.id, saved.id);
});

test('ANSWERING AGAIN REPLACES — one memory per condition, and the newest wins', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { controlKnowledge, h } = await setup(t);
  const first = await controlKnowledge.rememberAnswer(answer());
  await controlKnowledge.noteApplied(first.id);

  const second = await controlKnowledge.rememberAnswer(answer({
    answerText: 'Actually the board is right, leave it.',
    evidenceFingerprint: 'a'.repeat(32),
  }));
  assert.equal(second.id, first.id, 'the same row, not a second one');
  assert.equal(second.answerText, 'Actually the board is right, leave it.');
  // THE COUNT BELONGS TO THE ANSWER. Carrying it over would say a brand-new
  // answer had already been acted on four times.
  assert.equal(second.timesApplied, 0);
  assert.equal(second.lastAppliedAt, null);

  const rows = await h.query('SELECT COUNT(*)::int AS n FROM control_knowledge');
  assert.equal(rows.rows[0].n, 1);
});

test('the set of answers is a CHECK in the database, not a filter in JavaScript', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { controlKnowledge } = await setup(t);
  await assert.rejects(
    () => controlKnowledge.rememberAnswer(answer({ answerAction: 'deactivate' })),
    /control_knowledge_action_check/,
  );
});

test('A REVOKED MEMORY IS GONE FROM THE PATH THAT ACTS, and kept for the record', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { controlKnowledge, h } = await setup(t);
  const saved = await controlKnowledge.rememberAnswer(answer());
  const revoked = await controlKnowledge.revokeMemory(saved.id, { revokedBy: 'admin:1' });
  assert.ok(revoked.revokedAt);

  assert.equal(await controlKnowledge.findMemory({
    checkKey: FINDING.checkKey, subjectType: 'group', subjectId: '49',
  }), null);
  assert.deepEqual(await controlKnowledge.listMemories(), []);

  // Still there — "Wenze used to stop asking because you said X, and you took
  // that back on the 3rd" is worth keeping.
  const rows = await h.query('SELECT revoked_by FROM control_knowledge');
  assert.equal(rows.rows[0].revoked_by, 'admin:1');

  // And revoking twice is a no-op rather than an error.
  assert.equal(await controlKnowledge.revokeMemory(saved.id), null);
});

test('being acted on is counted, and a revoked memory cannot be', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { controlKnowledge } = await setup(t);
  const saved = await controlKnowledge.rememberAnswer(answer());
  const once = await controlKnowledge.noteApplied(saved.id);
  assert.equal(once.timesApplied, 1);
  assert.ok(once.lastAppliedAt);

  await controlKnowledge.revokeMemory(saved.id);
  assert.equal(await controlKnowledge.noteApplied(saved.id), null);
});

test('the health summary counts and never returns a word the owner typed', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { controlKnowledge } = await setup(t);
  const saved = await controlKnowledge.rememberAnswer(answer());
  await controlKnowledge.noteApplied(saved.id);
  const summary = await controlKnowledge.summariseKnowledge();
  assert.equal(summary.available, true);
  assert.equal(summary.live, 1);
  assert.equal(summary.applied, 1);
  assert.ok(!JSON.stringify(summary).includes('swapped trucks'));
});

test('A QUESTION ALREADY ANSWERED IS CLOSED, NOT ASKED AGAIN', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { controlKnowledge } = await setup(t);
  const { applyMemory } = require('../services/control/askPass');
  await controlKnowledge.rememberAnswer(answer());

  const dismissed = [];
  const deps = {
    knowledge: controlKnowledge,
    findings: {
      dismissFinding: async (id, patch) => { dismissed.push({ id, ...patch }); return { id }; },
    },
  };

  assert.equal(await applyMemory(FINDING, deps), true);
  assert.equal(dismissed.length, 1);
  // THE REASON NAMES WHERE THE ANSWER CAME FROM, and quotes it. Without that,
  // the admin shows a dismissal indistinguishable from somebody clicking.
  assert.match(dismissed[0].reason, /Already answered in the notification group/);
  assert.match(dismissed[0].reason, /swapped trucks/);
  assert.equal(dismissed[0].dismissedBy, 'telegram:2117922421');

  const after = await controlKnowledge.findMemory({
    checkKey: FINDING.checkKey, subjectType: 'group', subjectId: '49',
  });
  assert.equal(after.timesApplied, 1);
});

test('A NEW PROBLEM ABOUT THE SAME DRIVER IS STILL ASKED', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { controlKnowledge } = await setup(t);
  const { applyMemory } = require('../services/control/askPass');
  await controlKnowledge.rememberAnswer(answer());

  // The board now names a THIRD truck. Same driver, same check — a different
  // situation, and the one the owner settled has nothing to say about it.
  const different = {
    ...FINDING,
    evidence: { ...FINDING.evidence, boardTruck: '999' },
  };
  // RECORDED, NOT THROWN. `applyMemory` swallows a failed dismissal on purpose
  // — a memory that cannot be applied must cost the memory, not the pass — so a
  // stub that throws would make this test pass with the guard removed.
  const dismissed = [];
  const deps = {
    knowledge: controlKnowledge,
    findings: { dismissFinding: async (id) => { dismissed.push(id); return { id }; } },
  };
  assert.equal(await applyMemory(different, deps), false);
  assert.deepEqual(dismissed, [], 'nothing was closed');
});

test('A REMEMBERED YES NEVER CLOSES ANYTHING BY ITSELF', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { controlKnowledge } = await setup(t);
  const { applyMemory } = require('../services/control/askPass');
  await controlKnowledge.rememberAnswer(answer({ answerAction: 'approve', answerText: 'always yes' }));

  const dismissed = [];
  const deps = {
    knowledge: controlKnowledge,
    findings: { dismissFinding: async (id) => { dismissed.push(id); return { id }; } },
  };
  assert.equal(await applyMemory(FINDING, deps), false,
    'an approval is recorded and is never re-applied — that would be autopilot by the back door');
  assert.deepEqual(dismissed, [], 'and nothing was closed on the way');
});

test('the notice columns the clarification loop needs round-trip', {
  skip: skipWithoutPg(),
}, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { operationalNotifications } = h.loadDataLayer(['operationalNotifications']);
  const parent = await operationalNotifications.enqueueNotification({
    noticeKey: 'needs_attention:control_question:11:r0',
    category: 'needs_attention', chatId: '-100123', body: 'Close it?',
    subjectType: 'control_question', subjectId: '11',
    question: { findingId: 11, offeredActions: [{ key: 'dismiss', label: 'no' }] },
    findingId: null,
  });
  assert.equal(parent.clarifyRound, 0);
  assert.equal(parent.parentNoticeId, null);

  const child = await operationalNotifications.enqueueNotification({
    noticeKey: 'needs_attention:control_question:11:c1',
    category: 'needs_attention', chatId: '-100123', body: 'Why?',
    subjectType: 'control_question', subjectId: '11',
    question: { findingId: 11, offeredActions: [{ key: 'dismiss', label: 'no' }] },
    parentNoticeId: parent.id, clarifyRound: 1,
  });
  // `id` comes back from a BIGINT column as a string; `parentNoticeId` is
  // mapped to a number like `findingId` beside it. Compared as numbers here.
  assert.equal(child.parentNoticeId, Number(parent.id));
  assert.equal(child.clarifyRound, 1);
});
