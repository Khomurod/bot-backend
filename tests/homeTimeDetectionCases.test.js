/**
 * Home-Time detection — the SPEC CASES, verbatim.
 *
 * Six real driver-group messages that the classifier must get right. Each is
 * pinned at the level where the decision is actually made:
 *
 *   - the pure wording detectors (services/homeTimeSignals),
 *   - the AI intent classifier with a mocked Gemini (services/homeTimeIntentService),
 *   - the orchestrator's pure guards, evaluateAiStatusChange / shouldOpenRequest
 *     (services/homeTimeRequestService).
 *
 * The point of the suite is that ordinary operational conversation — repairs,
 * loads, yards, ETAs — must never open a home-time request or flip a driver's
 * home/road status just because it contains the words "home", "road" or "yo'lda".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const signals = require('../services/homeTimeSignals');
const { parseDriverStatus } = require('../services/homeTimeConstants');

const TODAY = '2026-07-29';

// ── the six messages, exactly as written in the spec ──

const M_TRAILER_REPAIR = "700 ml yurmaydi bu trailer. Yo'lda fix qilsak bo'ladimi aka";
const M_VAGUE_REQUEST = "My home time after tomorrow and I'm going to stay for the whole week";
const M_THIRD_PERSON_ETA = 'He is currently at home and will let us know once he gets to the truck';
const M_STATUS_HOME = 'Status: Home';
const M_ERRAND = 'I need to pass by home to pick up my clothes';
const M_DATED_REQUEST = 'I need four days of home time starting August 2';

// ── intent service with a mocked Gemini ──

function loadIntentService({ gemini } = {}) {
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

// ── orchestrator pure guards, with config/db stubbed so no env or PG is needed ──

function loadOrchestrator() {
  const configPath = path.resolve(__dirname, '../config/config.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const servicePath = path.resolve(__dirname, '../services/homeTimeRequestService.js');
  require.cache[configPath] = { exports: { employeeGroupId: '' } };
  require.cache[dbPath] = { exports: { query: async () => ({ rows: [] }), getDriverProfileByGroupId: async () => null } };
  delete require.cache[servicePath];
  return require(servicePath);
}

const CONFIDENT_REQUEST = {
  intent: 'home_time_request', confidence: 92, isActualStatusChange: false,
  requestedHomeTime: true, language: 'en', reason: 'AI thinks this is a request',
};
const CONFIDENT_HOME_STATUS = {
  intent: 'actual_home_status', confidence: 95, isActualStatusChange: true,
  requestedHomeTime: false, language: 'en', reason: 'AI thinks the driver is home',
};

function assertNotRequest(v) {
  assert.notEqual(v.intent, 'home_time_request');
  assert.equal(v.requestedHomeTime, false);
}

// ── 1. trailer repair in Uzbek — operational, no Home-Time action ──

test('CASE 1 "700 ml yurmaydi bu trailer. Yo\'lda fix qilsak bo\'ladimi aka" — operational, no action', () => {
  assert.equal(signals.hasOperationalContextSignal(M_TRAILER_REPAIR), true);
  assert.equal(signals.looksLikeOperationalContext(M_TRAILER_REPAIR), true);
  assert.equal(signals.hasExplicitTimeOffSignal(M_TRAILER_REPAIR), false);
});

test('CASE 1 — a confident AI "request" verdict is refused by the orchestrator guard', () => {
  const svc = loadOrchestrator();
  const decision = svc.shouldOpenRequest(
    { intent: 'home_time_request', requestedHomeTime: true, window: {} },
    { text: M_TRAILER_REPAIR },
  );
  assert.equal(decision.open, false);
  assert.match(decision.reason, /operational/i);
});

test('CASE 1 — "Yo\'lda" does NOT flip the driver to on-road status', () => {
  const svc = loadOrchestrator();
  const decision = svc.evaluateAiStatusChange(
    {
      intent: 'actual_road_status', isActualStatusChange: true, confidence: 95,
    },
    { text: M_TRAILER_REPAIR, senderIsDriver: true },
  );
  // Refused. It happens to trip the first-person gate first (the message is a
  // question about fixing a trailer, not a statement about the sender's status);
  // the operational gate below is proven independently.
  assert.equal(decision.allowed, false);
});

test('CASE 1 — the operational gate alone refuses a first-person road claim about a repair', () => {
  const svc = loadOrchestrator();
  const text = "I'm on the road but the trailer needs a tire fix";
  assert.equal(signals.looksLikeFirstPersonStatus(text), true, 'precondition: first-person');
  const decision = svc.evaluateAiStatusChange(
    { intent: 'actual_road_status', isActualStatusChange: true, confidence: 95 },
    { text, senderIsDriver: true },
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /operational/i);
});

// ── 2. genuine request, vague anchor — exact dates still needed ──

test('CASE 2 "My home time after tomorrow…" — genuine request', async () => {
  const svc = loadIntentService({ gemini: { ...CONFIDENT_REQUEST, confidence: 90 } });
  const v = await svc.classifyHomeTimeMessage({ triggerText: M_VAGUE_REQUEST, todayIso: TODAY });
  assert.ok(v.intent === 'home_time_request' || v.requestedHomeTime === true);
});

test('CASE 2 — the orchestrator opens it (explicit "home time" beats any operational word)', () => {
  const svc = loadOrchestrator();
  const decision = svc.shouldOpenRequest(
    { intent: 'home_time_request', requestedHomeTime: true, window: {} },
    { text: M_VAGUE_REQUEST },
  );
  assert.equal(decision.open, true);
});

test('CASE 2 — a vague anchor is NOT guessed into dates; both are still missing', async () => {
  // The classifier is given no concrete calendar date, because "after tomorrow"
  // + "the whole week" does not pin one down. The window must stay incomplete so
  // the workflow asks for exact arrive-home and return-to-road dates.
  const svc = loadIntentService({
    gemini: {
      ...CONFIDENT_REQUEST,
      homeStartDate: null, returnToRoadDate: null, lastDayHome: null, durationDays: null,
    },
  });
  const v = await svc.classifyHomeTimeMessage({ triggerText: M_VAGUE_REQUEST, todayIso: TODAY });
  assert.equal(v.window.complete, false);
  assert.equal(v.window.homeStartDate, null);
  assert.equal(v.window.returnToRoadDate, null);
  assert.deepEqual([...v.window.missingFields].sort(), ['home_start', 'return_to_road']);
});

// ── 3. third-person staff ETA update — no status change, no clarification ──

test('CASE 3 "He is currently at home and will let us know…" — not a first-person statement', () => {
  assert.equal(signals.looksLikeFirstPersonStatus(M_THIRD_PERSON_ETA), false);
  assert.equal(signals.looksLikeOperationalContext(M_THIRD_PERSON_ETA), true);
});

test('CASE 3 — no status change even with a confident AI verdict and a verified driver', () => {
  const svc = loadOrchestrator();
  const decision = svc.evaluateAiStatusChange(
    { intent: 'actual_home_status', isActualStatusChange: true, confidence: 95 },
    { text: M_THIRD_PERSON_ETA, senderIsDriver: true },
  );
  assert.equal(decision.allowed, false);
});

test('CASE 3 — no status change when the sender is staff, not the driver', () => {
  const svc = loadOrchestrator();
  for (const senderIsDriver of [false, null]) {
    const decision = svc.evaluateAiStatusChange(
      { intent: 'actual_home_status', isActualStatusChange: true, confidence: 99 },
      { text: M_THIRD_PERSON_ETA, senderIsDriver },
    );
    assert.equal(decision.allowed, false, `senderIsDriver=${senderIsDriver}`);
    assert.match(decision.reason, /not verified as the driver/i);
  }
});

test('CASE 3 — no unplanned-home clarification is opened either', () => {
  const svc = loadOrchestrator();
  const decision = svc.shouldOpenRequest(
    { intent: 'home_time_request', requestedHomeTime: true, window: {} },
    { text: M_THIRD_PERSON_ETA },
  );
  assert.equal(decision.open, false);
});

// ── 4. the deterministic status line still works ──

test('CASE 4 "Status: Home" — valid deterministic transition', () => {
  assert.equal(parseDriverStatus(M_STATUS_HOME), 'home');
  assert.equal(parseDriverStatus('Status: Ready'), 'road');
  assert.equal(parseDriverStatus('Status: Rolling'), 'road');
});

test('CASE 4 — the deterministic line is untouched by the new negative guards', () => {
  assert.equal(signals.looksLikeOperationalContext(M_STATUS_HOME), false);
  assert.equal(signals.looksLikeTemporaryHomeStop(M_STATUS_HOME), false);
});

test('CASE 4 — an AI verdict is not needed; the exact parser wins even with the AI down', async () => {
  const svc = loadIntentService({ gemini: new Error('no key') });
  const v = await svc.classifyHomeTimeMessage({ triggerText: M_STATUS_HOME, todayIso: TODAY });
  assert.equal(v.aiUsed, false);
  assert.equal(v.intent, 'actual_home_status');
  assert.equal(v.isActualStatusChange, true);
});

// ── 5. temporary stop — no request ──

test('CASE 5 "I need to pass by home to pick up my clothes" — temporary stop, no request', async () => {
  assert.equal(signals.looksLikeTemporaryHomeStop(M_ERRAND), true);
  const svc = loadIntentService({ gemini: { ...CONFIDENT_REQUEST } });
  const v = await svc.classifyHomeTimeMessage({ triggerText: M_ERRAND, todayIso: TODAY });
  assertNotRequest(v);
  assert.match(v.reason, /temporary stop|errand/i);
});

test('CASE 5 — it does not flip the driver to home either', () => {
  const svc = loadOrchestrator();
  const decision = svc.evaluateAiStatusChange(
    { intent: 'actual_home_status', isActualStatusChange: true, confidence: 95 },
    { text: M_ERRAND, senderIsDriver: true },
  );
  assert.equal(decision.allowed, false);
});

// ── 6. genuine request with a concrete anchor + duration ──

test('CASE 6 "I need four days of home time starting August 2" — genuine request with dates', async () => {
  const svc = loadIntentService({
    gemini: {
      intent: 'home_time_request', confidence: 93, isActualStatusChange: false,
      requestedHomeTime: true, language: 'en',
      homeStartDate: '2026-08-02', durationDays: 4, reason: 'four days of home time from Aug 2',
    },
  });
  const v = await svc.classifyHomeTimeMessage({ triggerText: M_DATED_REQUEST, todayIso: TODAY });
  assert.ok(v.intent === 'home_time_request' || v.requestedHomeTime === true);
  // Resolved by the EXISTING date model: anchor + duration → a complete window.
  assert.equal(v.window.homeStartDate, '2026-08-02');
  assert.equal(v.window.complete, true);
  assert.ok(v.window.returnToRoadDate, 'a return-to-road date should be derived');
});

test('CASE 6 — the orchestrator opens it', () => {
  const svc = loadOrchestrator();
  const decision = svc.shouldOpenRequest(
    {
      intent: 'home_time_request',
      requestedHomeTime: true,
      window: { homeStartDate: '2026-08-02', returnToRoadDate: '2026-08-06' },
    },
    { text: M_DATED_REQUEST },
  );
  assert.equal(decision.open, true);
});

// ── the guards must not swallow genuine requests that mention operations ──

test('a genuine request is still opened when it also mentions a load or a yard', () => {
  const svc = loadOrchestrator();
  const decision = svc.shouldOpenRequest(
    { intent: 'home_time_request', requestedHomeTime: true, window: {} },
    { text: 'After I deliver this load I need 4 days off, my trailer can stay at the yard' },
  );
  assert.equal(decision.open, true);
});

test('an operational message WITH a concrete date is still opened', () => {
  const svc = loadOrchestrator();
  const decision = svc.shouldOpenRequest(
    {
      intent: 'home_time_request',
      requestedHomeTime: true,
      window: { homeStartDate: '2026-08-02', returnToRoadDate: '2026-08-06' },
    },
    { text: 'dropping the trailer at the terminal, home Aug 2 back Aug 6' },
  );
  assert.equal(decision.open, true);
});

test('a verified first-person status change is still accepted', () => {
  const svc = loadOrchestrator();
  const decision = svc.evaluateAiStatusChange(
    { intent: 'actual_home_status', isActualStatusChange: true, confidence: 95 },
    { text: "I'm home now", senderIsDriver: true },
  );
  assert.equal(decision.allowed, true);
  assert.equal(decision.state, 'home');
});

test('a first-person status change below the confidence floor is refused', () => {
  const svc = loadOrchestrator();
  const decision = svc.evaluateAiStatusChange(
    { intent: 'actual_home_status', isActualStatusChange: true, confidence: 80 },
    { text: "I'm home now", senderIsDriver: true },
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /confidence 80 below 85/);
});
