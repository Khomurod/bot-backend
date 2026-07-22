/**
 * Home-time intent ACCURACY regression suite.
 *
 * These tests pin the behavior that matters most for correctness: the classifier
 * must key off the MEANING of a message, not the mere presence of "home"/"house".
 *
 *   - Genuine home-time requests (formal, informal, multilingual, staff-on-behalf,
 *     dated) keep working.
 *   - Temporary stops and personal errands near home (pass by the house, pick up
 *     belongings, drop someone off, pass through the hometown, sleep home one
 *     night, an appointment near home) NEVER open a request — even when the AI is
 *     over-confident or unavailable, and even when earlier context discussed home
 *     time.
 *
 * The Gemini client is mocked so each test drives an exact AI verdict (or an AI
 * outage). The false-positive example called out in the spec is covered verbatim.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const TODAY = '2026-07-13';

function loadService({ gemini } = {}) {
  const servicePath = path.resolve(__dirname, '../services/homeTimeIntentService.js');
  const geminiPath = path.resolve(__dirname, '../services/geminiClient.js');
  delete require.cache[servicePath];
  delete require.cache[geminiPath];
  require.cache[geminiPath] = {
    exports: {
      async callGeminiJson() {
        if (gemini instanceof Error) throw gemini;
        return { parsed: gemini };
      },
      async callGeminiText() { return { text: 'ok' }; },
    },
  };
  return require(servicePath);
}

// A confident AI "home_time_request" verdict — used to prove the deterministic
// backstop overrides the model when the text is really an errand.
const CONFIDENT_REQUEST = {
  intent: 'home_time_request', confidence: 92, isActualStatusChange: false,
  requestedHomeTime: true, language: 'en', reason: 'AI thinks this is a request',
};

const EXACT_FALSE_POSITIVE = 'Please talk to the driver. He needs to pass by his '
  + 'house to pick up his personal belongings.';

async function classify(svc, triggerText, extra = {}) {
  return svc.classifyHomeTimeMessage({ triggerText, todayIso: TODAY, ...extra });
}

function assertNotRequest(v) {
  assert.notEqual(v.intent, 'home_time_request');
  assert.equal(v.requestedHomeTime, false);
}

function assertRequest(v) {
  assert.ok(v.intent === 'home_time_request' || v.requestedHomeTime === true,
    `expected a request verdict, got intent=${v.intent} requested=${v.requestedHomeTime}`);
}

// ── The exact spec example ──

test('EXACT spec example: confident AI request on "pass by the house to grab belongings" is refused', async () => {
  const svc = loadService({ gemini: CONFIDENT_REQUEST });
  const v = await classify(svc, EXACT_FALSE_POSITIVE);
  assertNotRequest(v);
  assert.match(v.reason, /temporary stop|errand/i);
});

test('EXACT spec example: with the AI unavailable it still does NOT open a request', async () => {
  const svc = loadService({ gemini: new Error('no key') });
  const v = await classify(svc, EXACT_FALSE_POSITIVE);
  assert.equal(v.aiUsed, false);
  assertNotRequest(v);
});

// ── Temporary stops / personal errands — a CONFIDENT AI request is overridden ──

const ERRAND_MESSAGES = [
  ['pick up clothes', 'He needs to go home to pick up some clothes and then keep going'],
  ['pick up documents/medicine', 'Driver has to swing by the house to grab his documents and medicine'],
  ['drop someone off', 'He wants to drop his wife off at home then head back out'],
  ['drop something off', 'He is dropping the paperwork off at home real quick'],
  ['through the hometown', 'Route takes him through his hometown, he wants to grab a few things'],
  ['visit briefly, still working', 'He will stop by the house for a bit while finishing this load'],
  ['sleep home one night', "Route passes nearby so he'll be home for the night, back out tomorrow"],
  ['appointment near home', 'He has a dentist appointment near home tomorrow morning'],
];

for (const [label, message] of ERRAND_MESSAGES) {
  test(`errand not a request even when the AI is confident: ${label}`, async () => {
    const svc = loadService({ gemini: { ...CONFIDENT_REQUEST } });
    const v = await classify(svc, message);
    assertNotRequest(v);
    assert.match(v.reason, /temporary stop|errand/i);
  });
}

test('discussing someone\'s house (no time off) is not a request', async () => {
  // AI, reading the meaning, returns discussion; nothing forces a request.
  const svc = loadService({
    gemini: {
      intent: 'question_or_discussion', confidence: 70, isActualStatusChange: false,
      requestedHomeTime: false, reason: 'talking about the house',
    },
  });
  const v = await classify(svc, 'His house finally sold, he is happy about it');
  assertNotRequest(v);
});

// ── Genuine requests keep working (informal, dated, multilingual, on-behalf) ──

test('genuine informal request is kept (out 6 weeks, wants a few days with family)', async () => {
  const svc = loadService({ gemini: { ...CONFIDENT_REQUEST, confidence: 85 } });
  const v = await classify(svc, "He's been out 6 weeks and wants a few days with his family");
  assertRequest(v);
});

test('genuine request with explicit wording is kept even at LOW AI confidence', async () => {
  const svc = loadService({
    gemini: {
      intent: 'home_time_request', confidence: 25, isActualStatusChange: false, requestedHomeTime: true,
    },
  });
  const v = await classify(svc, 'he needs a few days off next month');
  assertRequest(v);
});

test('genuine request with explicit dates is kept even at LOW AI confidence', async () => {
  const svc = loadService({
    gemini: {
      intent: 'home_time_request', confidence: 20, isActualStatusChange: false,
      requestedHomeTime: true, homeStartDate: '2026-07-20', returnToRoadDate: '2026-07-24',
    },
  });
  const v = await classify(svc, 'home from the 20th to the 24th');
  assertRequest(v);
  assert.equal(v.window.homeStartDate, '2026-07-20');
  assert.equal(v.window.returnToRoadDate, '2026-07-24');
});

test('multilingual genuine request (Russian) is kept when the AI is confident', async () => {
  const svc = loadService({
    gemini: {
      intent: 'home_time_request', confidence: 88, isActualStatusChange: false,
      requestedHomeTime: true, language: 'ru', reason: 'хочет домой на несколько дней',
    },
  });
  const v = await classify(svc, 'Хочу домой на несколько дней отдохнуть');
  assertRequest(v);
});

test('staff-on-behalf genuine request is kept (sender is NOT the driver)', async () => {
  const svc = loadService({ gemini: { ...CONFIDENT_REQUEST, confidence: 90 } });
  const v = await classify(svc, 'Driver asked me to put in home time for him next week', { senderIsDriver: false });
  assertRequest(v);
});

// ── Prior context must not force a request on a new, unrelated errand message ──

test('misleading prior context: old home-time chat does NOT turn a new errand into a request', async () => {
  const svc = loadService({ gemini: { ...CONFIDENT_REQUEST, confidence: 80 } });
  const v = await classify(svc, 'he needs to swing by his house to grab his charger', {
    transcript: '@driver: can I get home time next month?\n@dispatch: we will see',
  });
  assertNotRequest(v);
  assert.match(v.reason, /temporary stop|errand/i);
});

// ── AI-unavailable fallback conservatism ──

test('fallback: "go home to grab his stuff" (strong wording + errand) does NOT open a request', async () => {
  const svc = loadService({ gemini: new Error('no key') });
  const v = await classify(svc, 'he needs to go home to grab his phone and charger');
  assert.equal(v.aiUsed, false);
  assertNotRequest(v);
});

test('fallback: a genuine "wants to go home" (no errand) DOES open a request', async () => {
  const svc = loadService({ gemini: new Error('no key') });
  const v = await classify(svc, 'the driver wants to go home, he has been out 6 weeks');
  assert.equal(v.aiUsed, false);
  assertRequest(v);
});

test('fallback: explicit "days off" opens a request', async () => {
  const svc = loadService({ gemini: new Error('no key') });
  const v = await classify(svc, 'he is asking for a few days off');
  assert.equal(v.aiUsed, false);
  assertRequest(v);
});
