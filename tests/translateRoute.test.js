/**
 * POST /api/translate (Send Message auto-translate) route behavior:
 *   - translates via the injected integrated translateBatch,
 *   - surfaces the clear "AI is not configured" message with a 503 when the
 *     integrated AI has no keys (manual sending is unaffected — the broadcast
 *     routes never touch translateBatch).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { createQuestionsRoutes } = require('../server/routes/questionsRoutes');
const { AI_NOT_CONFIGURED_MESSAGE } = require('../services/translationService');

function makeApp(translateBatch) {
  const app = express();
  app.use(express.json());
  app.use(createQuestionsRoutes({
    db: {},
    authMiddleware: (req, res, next) => next(),
    sendQuestionToGroups: async () => ({}),
    sendTestQuestion: async () => ({}),
    translateBatch,
  }));
  return app;
}

async function postTranslate(app, body) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  } finally {
    server.close();
  }
}

test('translate route returns translations from the integrated service', async () => {
  const app = makeApp(async (blocks, lang) => blocks.map((t) => `${lang}:${t}`));
  const { status, json } = await postTranslate(app, {
    source_language: 'en',
    target_languages: ['ru', 'uz'],
    text_blocks: ['Hello'],
  });
  assert.equal(status, 200);
  assert.deepEqual(json, { ru: ['ru:Hello'], uz: ['uz:Hello'] });
});

test('translate route returns 503 with the clear message when AI is not configured', async () => {
  const app = makeApp(async () => {
    const err = new Error(AI_NOT_CONFIGURED_MESSAGE);
    err.code = 'AI_NOT_CONFIGURED';
    err.statusCode = 503;
    throw err;
  });
  const { status, json } = await postTranslate(app, { text_blocks: ['Hello'] });
  assert.equal(status, 503);
  assert.equal(json.error, AI_NOT_CONFIGURED_MESSAGE);
  assert.match(json.error, /AI is not configured\. Configure the app/);
});

test('other translation failures stay a generic 500', async () => {
  const app = makeApp(async () => { throw new Error('provider exploded'); });
  const { status, json } = await postTranslate(app, { text_blocks: ['Hello'] });
  assert.equal(status, 500);
  assert.equal(json.error, 'Translation failed. Please try again.');
});
