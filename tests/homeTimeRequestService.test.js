const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DateTime } = require('luxon');

// Dates relative to "now" so isReasonableHomeWindow (which uses the real clock)
// always accepts them, regardless of when the suite runs.
const TODAY = DateTime.now().setZone('America/Chicago');
const FROM = TODAY.plus({ days: 3 }).toISODate();
const TO = TODAY.plus({ days: 9 }).toISODate();

/**
 * Load homeTimeRequestService with its DB / AI / Telegram dependencies mocked.
 * `gemini.json` controls the AI verdict: an Error rejects the call (so the
 * deterministic fallback runs); an object resolves as the parsed JSON.
 */
function loadService({
  gemini = {},
  open = null,
  awaiting = null,
  homeStatus = { state: 'road', state_since: '2026-05-01T00:00:00Z' },
  profile = { first_name: 'Pascal', last_name: 'F', unit_number: '96266', driver_type: 'company_driver' },
  transcript = '',
} = {}) {
  const servicePath = path.resolve(__dirname, '../services/homeTimeRequestService.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const htPath = path.resolve(__dirname, '../database/homeTime.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  const bufferPath = path.resolve(__dirname, '../services/recentMessageBuffer.js');
  const geminiPath = path.resolve(__dirname, '../services/geminiClient.js');
  const configPath = path.resolve(__dirname, '../config/config.js');

  for (const p of [servicePath, dbPath, htPath, htmlPath, bufferPath, geminiPath, configPath]) {
    delete require.cache[p];
  }

  require.cache[configPath] = { exports: { employeeGroupId: '' } };

  const inserts = [];
  const sends = [];
  const messageLinks = [];
  const fulfills = [];

  require.cache[dbPath] = {
    exports: { async getDriverProfileByGroupId() { return profile; } },
  };
  require.cache[htPath] = {
    exports: {
      async getOpenHomeTimeRequestForGroup() { return open; },
      async getAwaitingDatesHomeTimeRequestForGroup() { return awaiting; },
      async getHomeTimeSettings() { return { road_allowance_weeks: 4, home_allowance_days: 4 }; },
      async getDriverHomeStatus() { return homeStatus; },
      async insertHomeTimeRequest(payload) { inserts.push(payload); return { id: 99, ...payload }; },
      async fulfillAwaitingHomeTimeRequest(id, payload) {
        fulfills.push({ id, payload });
        return { id, ...payload };
      },
      async setHomeTimeRequestMessage(id, chatId, messageId) {
        messageLinks.push({ id, chatId, messageId });
        return { id };
      },
    },
  };
  require.cache[htmlPath] = { exports: { safeSend: async (fn) => fn() } };
  require.cache[bufferPath] = { exports: { renderTranscript() { return transcript; } } };

  const geminiCalls = { json: [] };
  require.cache[geminiPath] = {
    exports: {
      async callGeminiJson(opts) {
        geminiCalls.json.push(opts);
        if (gemini.json instanceof Error) throw gemini.json;
        // Allow a queue of responses for multi-call flows.
        if (Array.isArray(gemini.json)) {
          const next = gemini.json.shift();
          if (next instanceof Error) throw next;
          return { parsed: next };
        }
        return { parsed: gemini.json || { is_home_time_request: false } };
      },
      async callGeminiText() { return { text: 'A friendly bot note.' }; },
    },
  };

  const telegram = {
    async sendMessage(chatId, text, extra) {
      sends.push({ chatId, text, extra });
      return { message_id: 555 };
    },
  };

  return { service: require(servicePath), telegram, inserts, sends, messageLinks, fulfills, geminiCalls };
}

const GROUP = { id: 7, telegram_group_id: '-1007', group_type: 'driver', group_name: 'WENZE UNIT # 96266 (COMPANY DRIVER)' };

// ── classifier ──

test('classifyHomeTimeRequest: AI false → not a request', async () => {
  const { service } = loadService({ gemini: { json: { is_home_time_request: false, confidence: 'high', reason: 'oil change' } } });
  const verdict = await service.classifyHomeTimeRequest({ transcript: 'oil change', triggerText: 'need an oil change @tomr_robins0n' });
  assert.equal(verdict.isRequest, false);
  assert.equal(verdict.datesSpecified, false);
});

test('classifyHomeTimeRequest: request with valid dates is extracted', async () => {
  const { service } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: true, home_from: FROM, home_to: TO, reason: 'wants home' } },
  });
  const verdict = await service.classifyHomeTimeRequest({ triggerText: `home from ${FROM} to ${TO} @tomr_robins0n` });
  assert.equal(verdict.isRequest, true);
  assert.equal(verdict.datesSpecified, true);
  assert.equal(verdict.homeFrom, FROM);
  assert.equal(verdict.homeTo, TO);
});

test('classifyHomeTimeRequest: request without dates leaves datesSpecified false', async () => {
  const { service } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: false, home_from: null, home_to: null } },
  });
  const verdict = await service.classifyHomeTimeRequest({ triggerText: 'he wants to go home soon @tomr_robins0n' });
  assert.equal(verdict.isRequest, true);
  assert.equal(verdict.datesSpecified, false);
});

test('classifyHomeTimeRequest: implausible AI dates are rejected (treated as unspecified)', async () => {
  const { service } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: true, home_from: '1999-01-01', home_to: '1999-01-05' } },
  });
  const verdict = await service.classifyHomeTimeRequest({ triggerText: 'wants home @tomr_robins0n' });
  assert.equal(verdict.datesSpecified, false);
  assert.equal(verdict.homeFrom, null);
});

test('classifyHomeTimeRequest: low-confidence yes with no home wording is suppressed', async () => {
  const { service } = loadService({ gemini: { json: { is_home_time_request: true, confidence: 'low', reason: 'maybe' } } });
  const verdict = await service.classifyHomeTimeRequest({ transcript: 'load issue', triggerText: 'check this load @tomr_robins0n' });
  assert.equal(verdict.isRequest, false);
});

test('classifyHomeTimeRequest: AI unavailable → keyword heuristic + deterministic dates', async () => {
  const { service } = loadService({ gemini: { json: new Error('GEMINI_API_KEY is not configured') } });
  const verdict = await service.classifyHomeTimeRequest({ triggerText: `wants home time from ${FROM} to ${TO} @tomr_robins0n` });
  assert.equal(verdict.isRequest, true);
  assert.equal(verdict.aiUsed, false);
  assert.equal(verdict.datesSpecified, true);
  assert.equal(verdict.homeFrom, FROM);
});

// ── handleApproverMention ──

test('handleApproverMention: not a request → no card, no ask', async () => {
  const { service, telegram, inserts, sends } = loadService({
    gemini: { json: { is_home_time_request: false, confidence: 'high', reason: 'oil change' } },
  });
  await service.handleApproverMention(telegram, GROUP, { text: 'oil change @tomr_robins0n', from: { id: 1, username: 'rep' } });
  assert.equal(inserts.length, 0);
  assert.equal(sends.length, 0);
});

test('handleApproverMention: request WITH dates posts the card immediately', async () => {
  const { service, telegram, inserts, sends, messageLinks, geminiCalls } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: true, home_from: FROM, home_to: TO, reason: 'wants home' } },
    transcript: '@rep: driver out 6 weeks',
  });
  await service.handleApproverMention(telegram, GROUP, { text: `can he be home ${FROM} to ${TO} @tomr_robins0n`, from: { id: 1, username: 'rep' } });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].status, 'pending');
  assert.equal(inserts[0].homeFrom, FROM);
  assert.equal(sends.length, 1);
  assert.ok(sends[0].extra?.reply_markup, 'card should carry inline buttons');
  assert.equal(messageLinks.length, 1);
  assert.match(geminiCalls.json[0].userText, /can he be home/);
  assert.match(sends[0].text, new RegExp(FROM));
});

test('handleApproverMention: request WITHOUT dates asks the group and stays awaiting', async () => {
  const { service, telegram, inserts, sends, messageLinks } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: false, home_from: null, home_to: null } },
  });
  await service.handleApproverMention(telegram, GROUP, { text: 'he wants to go home @tomr_robins0n', from: { id: 1, username: 'rep' } });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].status, 'awaiting_dates');
  assert.equal(inserts[0].homeFrom, null);
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /what dates/i);
  assert.equal(sends[0].extra?.reply_markup, undefined, 'the ask message has no decision buttons');
  assert.equal(messageLinks.length, 0);
});

test('handleApproverMention: no-op when an open request already exists', async () => {
  const { service, telegram, inserts, sends } = loadService({
    open: { id: 1, status: 'awaiting_dates' },
    gemini: { json: { is_home_time_request: true, confidence: 'high' } },
  });
  await service.handleApproverMention(telegram, GROUP, { text: 'go home @tomr_robins0n', from: { id: 1 } });
  assert.equal(inserts.length, 0);
  assert.equal(sends.length, 0);
});

// ── handleHomeTimeDateReply ──

test('handleHomeTimeDateReply: no awaiting request → no-op', async () => {
  const { service, telegram, fulfills, sends } = loadService({
    awaiting: null,
    gemini: { json: { found: true, home_from: FROM, home_to: TO } },
  });
  await service.handleHomeTimeDateReply(telegram, GROUP, { text: `${FROM} to ${TO}`, from: { id: 1 } });
  assert.equal(fulfills.length, 0);
  assert.equal(sends.length, 0);
});

test('handleHomeTimeDateReply: non-date chatter is ignored (no DB/AI work)', async () => {
  const { service, telegram, fulfills, geminiCalls } = loadService({
    awaiting: { id: 42, status: 'awaiting_dates' },
    gemini: { json: { found: true, home_from: FROM, home_to: TO } },
  });
  await service.handleHomeTimeDateReply(telegram, GROUP, { text: 'ok thanks boss', from: { id: 1 } });
  assert.equal(fulfills.length, 0);
  assert.equal(geminiCalls.json.length, 0);
});

test('handleHomeTimeDateReply: a date reply fulfills the request and posts the card', async () => {
  const { service, telegram, fulfills, sends, messageLinks } = loadService({
    awaiting: { id: 42, status: 'awaiting_dates' },
    gemini: { json: { found: true, home_from: FROM, home_to: TO } },
  });
  await service.handleHomeTimeDateReply(telegram, GROUP, { text: `I want ${FROM} until ${TO}`, from: { id: 1, username: 'driver' } });
  assert.equal(fulfills.length, 1);
  assert.equal(fulfills[0].id, 42);
  assert.equal(fulfills[0].payload.homeFrom, FROM);
  assert.equal(sends.length, 1);
  assert.ok(sends[0].extra?.reply_markup, 'card should carry inline buttons');
  assert.equal(messageLinks.length, 1);
  assert.match(sends[0].text, new RegExp(TO));
});

test('handleHomeTimeDateReply: AI down but ISO dates → deterministic parser fulfills', async () => {
  const { service, telegram, fulfills, sends } = loadService({
    awaiting: { id: 42, status: 'awaiting_dates' },
    gemini: { json: new Error('GEMINI_API_KEY is not configured') },
  });
  await service.handleHomeTimeDateReply(telegram, GROUP, { text: `${FROM} to ${TO}`, from: { id: 1 } });
  assert.equal(fulfills.length, 1);
  assert.equal(fulfills[0].payload.homeFrom, FROM);
  assert.equal(sends.length, 1);
});

test('handleHomeTimeDateReply: unparseable date-looking reply keeps waiting', async () => {
  const { service, telegram, fulfills, sends } = loadService({
    awaiting: { id: 42, status: 'awaiting_dates' },
    gemini: { json: { found: false, home_from: null, home_to: null } },
  });
  // "monday" trips the cheap gate but the AI finds nothing and there is no
  // explicit date for the deterministic parser → still waiting.
  await service.handleHomeTimeDateReply(telegram, GROUP, { text: 'sometime monday maybe', from: { id: 1 } });
  assert.equal(fulfills.length, 0);
  assert.equal(sends.length, 0);
});
