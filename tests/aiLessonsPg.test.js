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
  const lessonArgs = {
    scope: 'hiring', about: 'Which stage? — "CLH sent"', understoodAs: 'CLEAN = MVR passed.', createdByName: 'Owner',
  };
  const saved = await aiLessons.answerWithLesson(q.id, {
    answerText: 'CLEAN means MVR passed', telegramUserId: 42, lesson: lessonArgs,
  });
  assert.equal(saved.question.status, 'answered');
  assert.equal(saved.lesson.statement, 'CLEAN means MVR passed');
  assert.equal(saved.lesson.source, 'owner_answer');
  assert.equal(await aiLessons.answerWithLesson(q.id, { answerText: 'again', telegramUserId: 42, lesson: lessonArgs }), null);
  assert.equal(await aiLessons.skipQuestion(q.id, { telegramUserId: 42 }), null);
  const lesson = saved.lesson;
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

test('a lesson that fails to insert rolls the claim back, so the answer can be given again', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { aiLessons } = await setup(t);
  const q = await aiLessons.queueQuestion(Q());
  await aiLessons.markAsked(q.id);
  await assert.rejects(aiLessons.answerWithLesson(q.id, {
    answerText: 'x', telegramUserId: 42, lesson: { scope: null, about: 'a' },
  }));
  assert.equal((await aiLessons.getQuestion(q.id)).status, 'asked');
  const saved = await aiLessons.answerWithLesson(q.id, {
    answerText: 'x', telegramUserId: 42, lesson: { scope: 'hiring', about: 'a' },
  });
  assert.equal(saved.question.status, 'answered');
});

test('the database lets only one question be out at a time', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { aiLessons } = await setup(t);
  const a = await aiLessons.queueQuestion(Q({ subjectKey: 'a' }));
  const b = await aiLessons.queueQuestion(Q({ subjectKey: 'b' }));
  await aiLessons.markAsked(a.id);
  await assert.rejects(aiLessons.markAsked(b.id), (err) => err.code === '23505');
});

test('owner answers are fetched before accounting reasons, whatever their age', {
  skip: skipWithoutPg(),
}, async (t) => {
  const { aiLessons } = await setup(t);
  await aiLessons.addLesson({ scope: 'home_time', source: 'owner_answer', about: 'o', statement: 'owner rule' });
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await aiLessons.addLesson({ scope: 'home_time', source: 'accounting_reason', about: 'a', statement: `reason ${i}` });
  }
  const top = await aiLessons.listActiveLessons('home_time', { limit: 2 });
  assert.equal(top[0].statement, 'owner rule');
  assert.equal(top[1].statement, 'reason 2');
});
