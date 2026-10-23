'use strict';

/**
 * database/aiLessons.js against PostgreSQL (migration 0083): one question per
 * subject, one out at a time, an answer claimed once, and a lesson taken back
 * rather than deleted. Requires TEST_DATABASE_URL.
 * See docs/architecture/ai-learning.md.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  return { h, ...h.loadDataLayer(['aiLessons', 'aiSettings']) };
}

const Q = (over = {}) => ({
  capability: 'hiring_stage_reading', subjectKey: 'chat:1', context: 'CLH sent', ask: 'Which stage?', confidence: 61.4, ...over,
});

test('the same subject is queued once; questions come out oldest first, one at a time', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { aiLessons } = await setup(t);
  const first = await aiLessons.queueQuestion(Q());
  assert.equal(first.status, 'queued');
  assert.equal(first.confidence, 61);
  assert.equal(await aiLessons.queueQuestion(Q({ context: 'changed' })), null);
  await aiLessons.queueQuestion(Q({ subjectKey: 'chat:2' }));

  assert.equal(await aiLessons.currentQuestion(), null);
  const next = await aiLessons.nextQueuedQuestion();
  assert.equal(next.id, first.id);
  assert.equal((await aiLessons.markAsked(next.id)).status, 'asked');
  assert.equal(await aiLessons.markAsked(next.id), null, 'two passes cannot both send it');
  assert.equal((await aiLessons.currentQuestion()).id, first.id);

  await aiLessons.unmarkAsked(first.id);
  assert.equal(await aiLessons.currentQuestion(), null);
  assert.equal((await aiLessons.nextQueuedQuestion()).id, first.id, 'back in line, still first');
});

test('an answer is claimed once and its lesson is linked; a removed lesson is kept and given to nobody', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { aiLessons } = await setup(t);
  const q = await aiLessons.queueQuestion(Q());
  await aiLessons.markAsked(q.id);
  const claimed = await aiLessons.claimAnswer(q.id, { answerText: 'CLEAN means MVR passed', telegramUserId: 42 });
  assert.equal(claimed.status, 'answered');
  assert.equal(await aiLessons.claimAnswer(q.id, { answerText: 'again', telegramUserId: 42 }), null);
  assert.equal(await aiLessons.skipQuestion(q.id, { telegramUserId: 42 }), null);

  const lesson = await aiLessons.addLesson({
    scope: 'hiring', source: 'owner_answer', about: 'Which stage? — "CLH sent"',
    statement: 'CLEAN means MVR passed', understoodAs: 'CLEAN = MVR passed.', questionId: q.id,
    createdByTelegramId: 42, createdByName: 'Owner',
  });
  assert.equal((await aiLessons.getQuestion(q.id)).lessonId, lesson.id);
  assert.equal((await aiLessons.listActiveLessons('hiring')).length, 1);
  assert.equal((await aiLessons.listActiveLessons('safety')).length, 0);

  const removed = await aiLessons.removeLesson(lesson.id, 'admin');
  assert.ok(removed.removedAt);
  assert.equal(await aiLessons.removeLesson(lesson.id, 'admin'), null);
  assert.equal((await aiLessons.listActiveLessons('hiring')).length, 0);
  const all = await aiLessons.listLessonsForAdmin();
  assert.equal(all.length, 1, 'kept, not deleted');
  assert.deepEqual(await aiLessons.summariseQuestions(), { queued: 0, asked: 0, answered: 1, skipped: 0 });
});

test('"Ask me when unsure" is on by default and can be switched off', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { aiSettings } = await setup(t);
  aiSettings.invalidateCache();
  assert.equal((await aiSettings.getAiSettings()).learningEnabled, true);
  assert.equal((await aiSettings.updateAiSettings({ learningEnabled: false })).learningEnabled, false);
});

test('accounting reasons are a lesson source; anything else is refused by the schema', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { aiLessons } = await setup(t);
  const ok = await aiLessons.addLesson({ scope: 'home_time', source: 'accounting_reason', about: 'early', statement: 'sick child' });
  assert.equal(ok.source, 'accounting_reason');
  await assert.rejects(aiLessons.addLesson({ scope: 'home_time', source: 'a_model', about: 'x', statement: 'y' }));
});
