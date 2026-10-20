'use strict';

/**
 * `annotateChatLogs` is the one door every annotation goes through — the
 * 15-minute pass and an on-demand AI report alike. These pin that only a
 * message carrying a leaving cue is sent to a model, and that every other one
 * is still recorded (as unread `no_signal`) so it is never selected again.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SERVICE = path.resolve(__dirname, '../services/aiAnnotationService.js');
const DB = path.resolve(__dirname, '../database/db.js');
const GROQ = path.resolve(__dirname, '../services/groqClient.js');
const REGISTRY = path.resolve(__dirname, '../services/ai/registry.js');

function load({ aiAvailable = true } = {}) {
  const calls = { prompts: [], writes: [] };
  for (const p of [SERVICE, DB, GROQ, REGISTRY]) delete require.cache[p];
  require.cache[DB] = {
    exports: {
      async query(sql, values) {
        calls.writes.push({ sql, values });
        return { rowCount: values.filter((v) => typeof v === 'number').length };
      },
    },
  };
  require.cache[GROQ] = {
    exports: {
      parseModelList: (_env, fallback) => fallback,
      GROQ_AI_FAST_MODEL: 'fast',
      GROQ_AI_FALLBACK_MODELS: [],
      async callGroqWithFallback(prompt) {
        calls.prompts.push(prompt);
        const ids = [...prompt.matchAll(/"id":\s*(\d+)/g)].map((m) => Number(m[1]));
        return {
          model: 'fast',
          text: JSON.stringify(ids.map((id) => ({ id, intent: 'quit_signal', role: 'driver', language: 'en' }))),
        };
      },
    },
  };
  require.cache[REGISTRY] = { exports: { isAiAvailable: async () => aiAvailable } };
  // eslint-disable-next-line global-require
  const svc = require(SERVICE);
  return { svc, calls };
}

const LOGS = [
  { id: 1, message_text: 'Status: Home', group_name: 'G', sender_name: 'A' },
  { id: 2, message_text: 'I quit, last load', group_name: 'G', sender_name: 'A' },
  { id: 3, message_text: 'ETA 6pm', group_name: 'G', sender_name: 'A' },
];

test('ONLY THE MESSAGE ABOUT LEAVING REACHES A MODEL', async () => {
  const { svc, calls } = load();
  const written = await svc.annotateChatLogs(LOGS);

  assert.equal(calls.prompts.length, 1, 'one model call, for one message');
  assert.match(calls.prompts[0], /I quit/);
  assert.doesNotMatch(calls.prompts[0], /Status: Home|ETA 6pm/);
  assert.equal(written, 3, 'and all three are recorded');

  const skipWrite = calls.writes.find((w) => w.values.includes('keyword-prefilter-v1'));
  assert.ok(skipWrite, 'the two ordinary messages are written as read-by-nobody');
  assert.ok(skipWrite.values.includes(1) && skipWrite.values.includes(3));
  assert.ok(!skipWrite.values.includes(2));
});

test('with AI off, the ordinary messages are still recorded and nothing is sent', async () => {
  const { svc, calls } = load({ aiAvailable: false });
  const written = await svc.annotateChatLogs(LOGS);
  assert.equal(calls.prompts.length, 0);
  assert.equal(written, 2, 'the cue message waits for AI; the others are settled');
});

test('a batch with no cue at all costs no model call', async () => {
  const { svc, calls } = load();
  await svc.annotateChatLogs([LOGS[0], LOGS[2]]);
  assert.equal(calls.prompts.length, 0);
});
