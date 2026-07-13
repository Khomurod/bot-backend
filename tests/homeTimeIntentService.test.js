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

test('isHomeTimeCandidate: status / home / road hints pass; ordinary chatter fails', () => {
  const svc = loadService({ gemini: {} });
  assert.equal(svc.isHomeTimeCandidate('Status: Home'), true);
  assert.equal(svc.isHomeTimeCandidate('he is home now'), true);
  assert.equal(svc.isHomeTimeCandidate('домой приехал'), true);
  assert.equal(svc.isHomeTimeCandidate('ready to roll'), true);
  assert.equal(svc.isHomeTimeCandidate('the rate on this load is wrong'), false);
  assert.equal(svc.isHomeTimeCandidate('friday', { hasOpenClarification: true }), true);
  // A bare weekday with NO open clarification must not trigger the AI.
  assert.equal(svc.isHomeTimeCandidate('friday', { hasOpenClarification: false }), false);
  assert.equal(svc.isHomeTimeCandidate('lol ok', { hasOpenClarification: true }), false);
});

test('AI actual_home_status is surfaced as an actual state change', async () => {
  const svc = loadService({
    gemini: {
      intent: 'actual_home_status', confidence: 95, isActualStatusChange: true,
      requestedHomeTime: false, language: 'en', reason: 'driver home',
    },
  });
  const v = await svc.classifyHomeTimeMessage({ triggerText: 'Status home', todayIso: TODAY });
  assert.equal(v.intent, 'actual_home_status');
  assert.equal(v.isActualStatusChange, true);
  assert.equal(v.aiUsed, true);
});

test('guardrail: a plan is never treated as an actual state change even if the AI slips', async () => {
  const svc = loadService({
    gemini: {
      intent: 'planned_home_status', confidence: 80, isActualStatusChange: true,
      requestedHomeTime: false, homeStartDate: '2026-07-20',
    },
  });
  const v = await svc.classifyHomeTimeMessage({ triggerText: 'I may go home next Monday', todayIso: TODAY });
  assert.equal(v.intent, 'planned_home_status');
  assert.equal(v.isActualStatusChange, false);
});

test('AI request with a start date only leaves the return missing (never dup)', async () => {
  const svc = loadService({
    gemini: {
      intent: 'home_time_request', confidence: 90, isActualStatusChange: false,
      requestedHomeTime: true, homeStartDate: '2026-07-20', returnToRoadDate: null,
    },
  });
  const v = await svc.classifyHomeTimeMessage({ triggerText: 'I need to be home next Monday', todayIso: TODAY });
  assert.equal(v.window.homeStartDate, '2026-07-20');
  assert.equal(v.window.returnToRoadDate, null);
  assert.deepEqual(v.window.missingFields, ['return_to_road']);
});

test('follow-up: only a return date + a KNOWN home start completes the window', async () => {
  const svc = loadService({
    gemini: {
      intent: 'home_time_followup', confidence: 88, isActualStatusChange: false,
      requestedHomeTime: false, returnToRoadDate: '2026-07-24',
    },
  });
  const v = await svc.classifyHomeTimeMessage({
    triggerText: 'back Friday', todayIso: TODAY, hasOpenClarification: true, knownHomeStart: '2026-07-20',
  });
  assert.equal(v.intent, 'home_time_followup');
  assert.equal(v.window.complete, true);
  assert.equal(v.window.homeStartDate, '2026-07-20');
  assert.equal(v.window.returnToRoadDate, '2026-07-24');
});

test('AI unavailable: exact Status: Home falls back to actual_home_status', async () => {
  const svc = loadService({ gemini: new Error('no key') });
  const v = await svc.classifyHomeTimeMessage({ triggerText: 'Status: Home', todayIso: TODAY });
  assert.equal(v.aiUsed, false);
  assert.equal(v.intent, 'actual_home_status');
  assert.equal(v.isActualStatusChange, true);
});

test('AI unavailable: casual "almost home" is NOT an actual state change', async () => {
  const svc = loadService({ gemini: new Error('no key') });
  const v = await svc.classifyHomeTimeMessage({ triggerText: 'almost home boss', todayIso: TODAY });
  assert.equal(v.isActualStatusChange, false);
  assert.equal(v.intent, 'unrelated');
});
