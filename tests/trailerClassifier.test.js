/**
 * Unit tests for services/trailerClassifier.js — the AI fallback classifier.
 * The Gemini client is replaced with an in-memory fake so no network is used.
 * Focus: output validation, unit-grounding, and low-confidence collapse.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadClassifierWith(fakeGemini) {
  const modPath = path.resolve(__dirname, '../services/trailerClassifier.js');
  const geminiPath = path.resolve(__dirname, '../services/geminiClient.js');
  delete require.cache[modPath];
  require.cache[geminiPath] = { exports: fakeGemini };
  return require(modPath);
}

function makeGemini(parsed, { apiKey = 'test-key' } = {}) {
  return {
    GEMINI_API_KEY: apiKey,
    callGeminiJson: async () => ({ parsed, model: 'fake-model' }),
  };
}

test('returns null when AI is not configured', async () => {
  const c = loadClassifierWith(makeGemini({ eventType: 'pickup' }, { apiKey: '' }));
  const r = await c.classifyTrailerMessageWithAi('trl ST123 picked up');
  assert.equal(r, null);
});

test('valid pickup with grounded unit is trusted', async () => {
  const c = loadClassifierWith(makeGemini({
    eventType: 'pickup', trailerUnit: 'ST508998', locationText: 'Lancaster PA',
    conditionText: 'no pictures', eventDateText: '7/10', mentionedDriverName: 'Enicson', confidence: 90,
    reason: 'clear pickup',
  }));
  const r = await c.classifyTrailerMessageWithAi('trl # ST508998 picked up Lancaster PA');
  assert.equal(r.eventType, 'pickup');
  assert.equal(r.trailerUnit, 'ST508998');
  assert.equal(r.locationText, 'Lancaster PA');
  assert.equal(r.method, 'ai');
});

test('hallucinated unit not present in message is dropped → unidentified', async () => {
  const c = loadClassifierWith(makeGemini({
    eventType: 'pickup', trailerUnit: 'ZZ999999', confidence: 95, reason: 'made up',
  }));
  const r = await c.classifyTrailerMessageWithAi('picked up the trailer somewhere');
  assert.equal(r.trailerUnit, null);
  assert.equal(r.eventType, 'unidentified'); // action with no grounded unit cannot stand
});

test('low-confidence action collapses to mention_only', async () => {
  const c = loadClassifierWith(makeGemini({
    eventType: 'pickup', trailerUnit: 'ST123', confidence: 20, reason: 'unsure',
  }));
  const r = await c.classifyTrailerMessageWithAi('maybe trl ST123 hmm');
  assert.equal(r.eventType, 'mention_only');
});

test('confidence given as 0..1 is scaled to 0..100', async () => {
  const c = loadClassifierWith(makeGemini({
    eventType: 'dropoff', trailerUnit: 'VT700669', confidence: 0.85, reason: 'ok',
  }));
  const r = await c.classifyTrailerMessageWithAi('trl VT700669 dropped off');
  assert.equal(r.confidence, 85);
  assert.equal(r.eventType, 'dropoff');
});

test('malformed AI output (bad eventType) is rejected via validateParsed', async () => {
  // The real callGeminiJson would throw when validateParsed fails; emulate that.
  const modPath = path.resolve(__dirname, '../services/trailerClassifier.js');
  const geminiPath = path.resolve(__dirname, '../services/geminiClient.js');
  delete require.cache[modPath];
  require.cache[geminiPath] = {
    exports: {
      GEMINI_API_KEY: 'test-key',
      callGeminiJson: async ({ validateParsed }) => {
        const bad = { eventType: 'nonsense' };
        if (validateParsed && validateParsed(bad) !== true) throw new Error('Gemini JSON failed validation');
        return { parsed: bad, model: 'fake' };
      },
    },
  };
  const c = require(modPath);
  const r = await c.classifyTrailerMessageWithAi('trl ST123 picked up');
  assert.equal(r, null); // failure → null, caller keeps deterministic result
});
