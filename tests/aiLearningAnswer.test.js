'use strict';

/**
 * services/ai/learning — asking the owner one question at a time, and keeping
 * the answer as a lesson. Stores and the bot are replaced.
 * See docs/architecture/ai-learning.md.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleLessonReply } = require('../services/ai/learning/answer');
const { askNextQuestion, queueAndAsk, SUBJECT_TYPE } = require('../services/ai/learning/askOwner');
const { recordAccountingReason, aboutViolation } = require('../services/ai/learning/accountingReasons');

const QUESTION = {
  id: 7, capability: 'safety_approval_reading', context: 'Safety replied "ok go"',
  ask: 'What did Safety decide?', status: 'asked', confidence: 60,
};

function answerDeps(over = {}) {
  const calls = { acks: [], lessons: [], asked: 0, claims: [] };
  const deps = {
    notices: {
      async findNoticeByTelegramMessage(chatId, msgId) {
        return msgId === 500 ? { id: 1, subjectType: SUBJECT_TYPE, subjectId: '7' } : null;
      },
    },
    store: {
      async getQuestion() { return over.question === undefined ? { ...QUESTION } : over.question; },
      async answerWithLesson(id, a) {
        calls.claims.push(a);
        if (over.claim === null) return null;
        const lesson = { ...a.lesson, statement: a.answerText, source: 'owner_answer', questionId: id };
        calls.lessons.push(lesson);
        return { question: { ...QUESTION, status: 'answered' }, lesson };
      },
      async skipQuestion() { return { ...QUESTION, status: 'skipped' }; },
    },
    operators: { async isControlOperator(id) { return String(id) === '42'; } },
    runCapability: over.runCapability || (async () => ({ text: '"ok go" from Safety means approved.' })),
    askNext: async () => { calls.asked += 1; },
    ack: async (a) => { calls.acks.push(a.text); },
  };
  return { deps, calls };
}

const reply = (over = {}) => ({
  chatId: -100, chatType: 'supergroup', messageId: 900, repliedToMessageId: 500,
  text: 'ok go means approved', telegramUserId: 42, fromIsBot: false, fromName: 'Owner', ...over,
});

test('an operator\'s answer becomes a lesson in their own words, said back, and the next question goes out', async () => {
  const { deps, calls } = answerDeps();
  const out = await handleLessonReply(reply(), deps);
  assert.equal(out.outcome, 'learned');
  assert.equal(calls.lessons.length, 1);
  assert.equal(calls.lessons[0].statement, 'ok go means approved', 'the words, not the restatement');
  assert.equal(calls.lessons[0].understoodAs, '"ok go" from Safety means approved.');
  assert.equal(calls.lessons[0].scope, 'safety');
  assert.equal(calls.lessons[0].source, 'owner_answer');
  assert.deepEqual(calls.acks, ['Understood: "ok go" from Safety means approved. Saved — I will use this from now on.']);
  assert.equal(calls.asked, 1);
});

test('no model: Wenze says back the owner\'s own words', async () => {
  const { deps, calls } = answerDeps({ runCapability: async () => { throw new Error('no provider'); } });
  await handleLessonReply(reply(), deps);
  assert.equal(calls.lessons[0].understoodAs, 'ok go means approved');
  assert.match(calls.acks[0], /^Understood: ok go means approved/);
});

test('a stranger is consumed, never answered, and teaches nothing', async () => {
  const { deps, calls } = answerDeps();
  const out = await handleLessonReply(reply({ telegramUserId: 99 }), deps);
  assert.equal(out.outcome, 'ignored_unauthorised');
  assert.equal(calls.lessons.length, 0);
  assert.equal(calls.acks.length, 0);
});

test('a redelivered reply, or a second operator, writes nothing and is not thanked twice', async () => {
  const { deps, calls } = answerDeps({ claim: null });
  const out = await handleLessonReply(reply(), deps);
  assert.equal(out.outcome, 'already_answered');
  assert.equal(calls.lessons.length, 0);
  assert.equal(calls.acks.length, 0);
});

test('an already answered question is said so and nothing is kept', async () => {
  const { deps, calls } = answerDeps({ question: { ...QUESTION, status: 'answered' } });
  const out = await handleLessonReply(reply(), deps);
  assert.equal(out.outcome, 'already_answered');
  assert.equal(calls.claims.length, 0);
});

test('"skip" moves on without a lesson', async () => {
  const { deps, calls } = answerDeps();
  const out = await handleLessonReply(reply({ text: 'skip' }), deps);
  assert.equal(out.outcome, 'skipped');
  assert.equal(calls.lessons.length, 0);
  assert.equal(calls.asked, 1);
});

test('anything that is not a reply to one of our questions passes through', async () => {
  const { deps } = answerDeps();
  assert.equal((await handleLessonReply(reply({ repliedToMessageId: 1 }), deps)).handled, false);
  assert.equal((await handleLessonReply(reply({ chatType: 'private' }), deps)).handled, false);
  assert.equal((await handleLessonReply(reply({ fromIsBot: true }), deps)).handled, false);
});

function askDeps(over = {}) {
  const calls = { notified: [], marked: [], unmarked: [], queued: [] };
  const deps = {
    getAiSettings: async () => ({ enabled: true, learningEnabled: over.learningEnabled ?? true }),
    store: {
      async currentQuestion() { return over.current || null; },
      async nextQueuedQuestion() { return over.next === undefined ? { ...QUESTION, status: 'queued' } : over.next; },
      async markAsked(id) { calls.marked.push(id); return { ...QUESTION, id }; },
      async unmarkAsked(id) { calls.unmarked.push(id); },
      async queueQuestion(q) { calls.queued.push(q); return over.queued === undefined ? { id: 8, ...q } : over.queued; },
    },
    notify: async (n) => { calls.notified.push(n); return over.notifyResult || { recorded: true, delivered: true }; },
  };
  return { deps, calls };
}

test('two passes at once: the database\'s one-asked index makes the second one wait', async () => {
  const { deps, calls } = askDeps();
  deps.store.markAsked = async () => { throw Object.assign(new Error('duplicate key'), { code: '23505' }); };
  assert.equal((await askNextQuestion(deps)).reason, 'waiting_for_answer');
  assert.equal(calls.notified.length, 0);
});

test('one at a time: nothing goes out while a question waits for an answer', async () => {
  const { deps, calls } = askDeps({ current: { ...QUESTION } });
  assert.equal((await askNextQuestion(deps)).reason, 'waiting_for_answer');
  assert.equal(calls.notified.length, 0);
});

test('the oldest waiting question goes to the ai_learning group, with no buttons', async () => {
  const { deps, calls } = askDeps();
  const out = await askNextQuestion(deps);
  assert.equal(out.asked, true);
  assert.equal(calls.notified[0].category, 'ai_learning');
  assert.equal(calls.notified[0].subjectType, SUBJECT_TYPE);
  assert.equal(calls.notified[0].subjectId, '7');
  assert.equal(calls.notified[0].question, undefined, 'no question_json, so no buttons');
});

test('a question that reached nobody goes back in line; switched off asks nothing', async () => {
  const lost = askDeps({ notifyResult: { recorded: false, reason: 'no_destination' } });
  assert.equal((await askNextQuestion(lost.deps)).reason, 'no_destination');
  assert.deepEqual(lost.calls.unmarked, [7]);
  const off = askDeps({ learningEnabled: false });
  assert.equal((await askNextQuestion(off.deps)).reason, 'off');
  assert.equal((await queueAndAsk({ capability: 'hiring_stage_reading', subjectKey: 'b', context: 'c', ask: 'q' }, off.deps)).reason, 'off');
  assert.equal(off.calls.queued.length, 0, 'switched off queues nothing either');
  assert.equal(off.calls.notified.length, 0);
});

test('the same subject is queued once', async () => {
  const { deps, calls } = askDeps({ queued: null });
  const out = await queueAndAsk({ capability: 'hiring_stage_reading', subjectKey: 'a', context: 'c', ask: 'q' }, deps);
  assert.equal(out.reason, 'already_known');
  assert.equal(calls.notified.length, 0);
});

test('accounting\'s "Not charging" reason is kept for home time, without the driver\'s name', async () => {
  const rows = [{ violation: 'early', road_days: 12, home_days: 3, driver_name: 'TEST DRIVER' }];
  assert.equal(aboutViolation(rows), 'A company driver came home early after 12 days on the road; accounting did not charge them');
  const added = [];
  await recordAccountingReason(rows, '  family emergency  ', { name: 'Ella', telegramUserId: 5 }, {
    store: { async addLesson(l) { added.push(l); return l; } },
  });
  assert.equal(added[0].scope, 'home_time');
  assert.equal(added[0].source, 'accounting_reason');
  assert.equal(added[0].statement, 'family emergency');
  assert.ok(!added[0].about.includes('TEST DRIVER'));
  assert.equal(await recordAccountingReason(rows, '   ', {}, { store: { addLesson() { throw new Error('not called'); } } }), null);
});

test('hooks: lessons are read once per scope and a failed read is "no lessons", not an error', async () => {
  const hooks = require('../services/ai/learning/hooks');
  hooks.invalidateLessons();
  let reads = 0;
  const lessons = { async listActiveLessons() { reads += 1; return [{ source: 'owner_answer', about: 'a', statement: 'b' }]; } };
  assert.match(await hooks.lessonsFor('hiring_stage_reading', { now: 0, lessons }), /The owner answered: "b"/);
  await hooks.lessonsFor('hiring_stage_reading', { now: 1000, lessons });
  assert.equal(reads, 1);
  assert.equal(await hooks.lessonsFor('employee_birthday_message', { lessons }), '');
  hooks.invalidateLessons();
  const broken = { async listActiveLessons() { throw new Error('db down'); } };
  assert.equal(await hooks.lessonsFor('safety_approval_reading', { now: 0, lessons: broken }), '');
  hooks.invalidateLessons();
});

test('hooks: only a caller that said what to ask raises a question, masked', async () => {
  const hooks = require('../services/ai/learning/hooks');
  const asked = [];
  const ask = async (q) => { asked.push(q); };
  hooks.onUncertain({ capability: 'hiring_stage_reading' }, { confidence: 40 }, { ask });
  hooks.onUncertain({ capability: 'hiring_stage_reading', learning: { context: 'call 3125550199', ask: 'Which?' } },
    { confidence: 40 }, { ask });
  await new Promise((r) => setImmediate(r));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].context, 'call •••0199');
  assert.equal(asked[0].confidence, 40);
  assert.ok(asked[0].subjectKey, 'a key is made when the caller gave none');
});
