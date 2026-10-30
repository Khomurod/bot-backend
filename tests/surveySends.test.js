/**
 * Surveys get a screen (Messages → Surveys → New survey, Send, Close survey).
 * What the server has to guarantee for that screen to be honest:
 *
 *   - a survey is stored only COMPLETE: the question and every option, non-blank,
 *     in en / ru / uz, with 2–10 options — a blank Uzbek option would be a blank
 *     button in every Uzbek group;
 *   - a CLOSED survey can be neither sent (409) nor answered ("This survey is
 *     closed.", nothing recorded) — before this, "deactivate" changed a flag
 *     nothing read;
 *   - a send that reached at least one group is remembered on the question, and
 *     failing to remember it never turns delivered messages into an error.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const dbPath = require.resolve('../database/db');
const fakeDb = {};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const { createQuestionsRoutes } = require('../server/routes/questionsRoutes');
const { normalizeSurveyBody } = require('../server/routes/helpers/surveyBodyHelpers');
const { createQuestionSenders } = require('../bot/senders/questionSenders');
const { registerSurveyCallbackHandlers } = require('../bot/handlers/surveyCallbackHandlers');

const tr = (en, ru, uz, field) => [['en', en], ['ru', ru], ['uz', uz]].map(([language, text]) => ({ language, [field]: text }));
const question = (en = 'How was the load?', ru = 'Как груз?', uz = 'Yuk qanday?') => tr(en, ru, uz, 'question_text');
const option = (en, ru = `${en}-ru`, uz = `${en}-uz`) => ({ translations: tr(en, ru, uz, 'option_text') });

async function request(app, method, path, body) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: await res.json() };
  } finally {
    server.close();
  }
}

function routesWith({ db = {}, sendQuestionToGroups = async () => ({}) } = {}) {
  const app = express();
  app.use(express.json());
  app.use(createQuestionsRoutes({
    db, authMiddleware: (req, res, next) => next(), sendQuestionToGroups,
    sendTestQuestion: async () => {}, translateBatch: async () => [],
  }));
  return app;
}

// ─── what may be stored ──────────────────────────────────────────────────────

test('a survey is refused unless the question and every option are filled in all three languages', () => {
  assert.match(normalizeSurveyBody({ translations: question('Q', 'В', ' '), options: [option('A'), option('B')] }).error, /English, Russian and Uzbek/);
  assert.match(normalizeSurveyBody({ translations: question(), options: [option('A')] }).error, /at least 2/);
  assert.match(normalizeSurveyBody({ translations: question(), options: Array.from({ length: 11 }, (_, i) => option(`O${i}`)) }).error, /at most 10/);
  assert.equal(
    normalizeSurveyBody({ translations: question(), options: [option('Yes'), option('No', 'Нет', '')] }).error,
    'Option 2 needs text in English, Russian and Uzbek.',
  );
  assert.match(normalizeSurveyBody({}).error, /question is required/);
});

test('a complete survey is trimmed and its options numbered in the order given', () => {
  const out = normalizeSurveyBody({
    translations: [...question(' Q ', ' В ', ' S '), { language: 'de', question_text: 'ignored' }],
    options: [option(' Yes ', ' Да ', ' Ha '), option('No')],
  });
  assert.deepEqual(out.translations.map((t) => t.question_text), ['Q', 'В', 'S']);
  assert.deepEqual(out.options.map((o) => o.option_order), [1, 2]);
  assert.deepEqual(out.options[0].translations, [
    { language: 'en', option_text: 'Yes' }, { language: 'ru', option_text: 'Да' }, { language: 'uz', option_text: 'Ha' },
  ]);
});

test('POST /api/questions stores only the normalized survey and answers 400 with the reason otherwise', async () => {
  const created = [];
  const db = {
    createQuestion: async (...args) => { created.push(args); return { id: 7 }; },
    getQuestionWithOptions: async (id) => ({ id }),
  };
  const bad = await request(routesWith({ db }), 'POST', '/api/questions', { translations: question(), options: [option('Only')] });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error, 'A survey needs at least 2 answer options.');
  assert.equal(created.length, 0);

  const ok = await request(routesWith({ db }), 'POST', '/api/questions', { translations: question(), options: [option('Yes'), option('No')] });
  assert.equal(ok.status, 201);
  assert.equal(created.length, 1);
  const [translations, options, media, position] = created[0];
  assert.equal(translations.length, 3);
  assert.deepEqual(options.map((o) => o.option_order), [1, 2]);
  assert.equal(media, null);
  assert.equal(position, 'above');
});

test('sending a closed survey is a 409 with the reason, not a 500', async () => {
  const sendQuestionToGroups = async () => { throw Object.assign(new Error('This survey is closed; it can no longer be sent.'), { status: 409 }); };
  const res = await request(routesWith({ sendQuestionToGroups }), 'POST', '/api/questions/3/send');
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'This survey is closed; it can no longer be sent.');
});

// ─── sending ─────────────────────────────────────────────────────────────────

function senderWith({ active = true, groups = [], failFor = [], recordFails = false } = {}) {
  const sent = [];
  const recorded = [];
  const db = {
    getQuestionWithOptions: async (id) => ({
      id, active, translations: question(), media_items: [],
      options: [{ id: 11, option_order: 1, translations: option('Yes').translations }],
    }),
    getAllGroups: async () => groups,
    recordQuestionSent: async (id, n) => { if (recordFails) throw new Error('db down'); recorded.push([id, n]); },
    deactivateGroup: async () => {},
  };
  const bot = { telegram: { sendMessage: async (chatId, text) => {
    if (failFor.includes(chatId)) throw new Error('Bad Request: chat not found');
    sent.push([chatId, text]);
  } } };
  const { sendQuestionToGroups } = createQuestionSenders({ bot, db, config: { managementGroupId: -1 }, sendMedia: async () => {} });
  return { sendQuestionToGroups, sent, recorded };
}

test('a closed survey is refused before a single message goes out', async () => {
  const s = senderWith({ active: false, groups: [{ telegram_group_id: -10, group_name: 'A', language: 'en' }] });
  await assert.rejects(() => s.sendQuestionToGroups(3), (e) => e.status === 409);
  assert.equal(s.sent.length, 0);
  assert.equal(s.recorded.length, 0);
});

test('each group gets its own language, and the send is remembered with the number delivered', async () => {
  const s = senderWith({ groups: [
    { telegram_group_id: -10, group_name: 'A', language: 'ru' },
    { telegram_group_id: -20, group_name: 'B', language: 'uz' },
    { telegram_group_id: -30, group_name: 'Gone', language: 'en' },
  ], failFor: [-30] });
  const result = await s.sendQuestionToGroups(3);
  assert.equal(result.sent, 2);
  assert.equal(result.failed, 1);
  assert.deepEqual(s.sent.map(([, text]) => text), ['📋 Как груз?', '📋 Yuk qanday?']);
  assert.deepEqual(s.recorded, [[3, 2]]);
});

test('a send that reached nobody is not remembered, and a failed record does not fail the send', async () => {
  const none = senderWith({ groups: [{ telegram_group_id: -30, group_name: 'Gone', language: 'en' }], failFor: [-30] });
  await none.sendQuestionToGroups(3);
  assert.equal(none.recorded.length, 0);

  const s = senderWith({ groups: [{ telegram_group_id: -10, group_name: 'A', language: 'en' }], recordFails: true });
  const result = await s.sendQuestionToGroups(3);
  assert.equal(result.sent, 1);
});

// ─── answering ───────────────────────────────────────────────────────────────

function answerHandler() {
  const handlers = {};
  registerSurveyCallbackHandlers({ action() {}, on(event, fn) { handlers[event] = fn; }, telegram: {} });
  return handlers.callback_query;
}

function tap(data) {
  const replies = [];
  return {
    replies,
    ctx: {
      callbackQuery: { data, message: { chat: { id: -10, title: 'A' } } },
      from: { id: 5, first_name: 'Test' },
      answerCbQuery: async (text) => { replies.push(text); },
    },
  };
}

test('a tap on a closed survey is told so and nothing is recorded', async () => {
  const saved = [];
  Object.assign(fakeDb, {
    isQuestionOpen: async () => false,
    upsertDriver: async () => { throw new Error('must not register a driver for a closed survey'); },
    saveResponse: async (...args) => { saved.push(args); return { id: 1 }; },
  });
  const { ctx, replies } = tap('answer_3_11');
  await answerHandler()(ctx);
  assert.deepEqual(replies, ['This survey is closed.']);
  assert.equal(saved.length, 0);
});

test('a tap on an open survey is still recorded and thanked', async () => {
  const saved = [];
  Object.assign(fakeDb, {
    isQuestionOpen: async () => true,
    upsertDriver: async () => ({ id: 1, telegram_user_id: 5 }),
    getGroupByTelegramId: async () => ({ id: 2 }),
    saveResponse: async (...args) => { saved.push(args); return { id: 9 }; },
    getQuestionWithOptions: async () => null,
  });
  const { ctx, replies } = tap('answer_3_11');
  await answerHandler()(ctx);
  assert.deepEqual(replies, ['Thank you for your feedback!']);
  assert.deepEqual(saved, [[1, 2, 3, 11]]);
});

test('a tap the insert refuses because the survey closed a moment ago is told "closed", not "already answered"', async () => {
  let checks = 0;
  Object.assign(fakeDb, {
    isQuestionOpen: async () => (checks++ === 0), // open at the first look, closed by the insert
    upsertDriver: async () => ({ id: 1, telegram_user_id: 5 }),
    getGroupByTelegramId: async () => ({ id: 2 }),
    saveResponse: async () => null,
  });
  const { ctx, replies } = tap('answer_3_11');
  await answerHandler()(ctx);
  assert.deepEqual(replies, ['This survey is closed.']);
});
