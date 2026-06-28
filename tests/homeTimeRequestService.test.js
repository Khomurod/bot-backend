const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * Load homeTimeRequestService with its DB / AI / Telegram dependencies mocked.
 * `gemini.json` controls the AI verdict: an Error rejects the call (so the
 * keyword fallback runs); an object resolves as the parsed JSON.
 */
function loadService({
  gemini = {},
  pending = null,
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

  require.cache[dbPath] = {
    exports: { async getDriverProfileByGroupId() { return profile; } },
  };
  require.cache[htPath] = {
    exports: {
      async getPendingHomeTimeRequestForGroup() { return pending; },
      async getHomeTimeSettings() { return { road_allowance_weeks: 4, home_allowance_days: 4 }; },
      async getDriverHomeStatus() { return homeStatus; },
      async insertHomeTimeRequest(payload) { inserts.push(payload); return { id: 99, ...payload }; },
      async setHomeTimeRequestMessage(id, chatId, messageId) {
        messageLinks.push({ id, chatId, messageId });
        return { id };
      },
    },
  };
  require.cache[htmlPath] = { exports: { safeSend: async (fn) => fn() } };
  require.cache[bufferPath] = {
    exports: { renderTranscript() { return transcript; } },
  };

  const geminiCalls = { json: [], text: [] };
  require.cache[geminiPath] = {
    exports: {
      async callGeminiJson(opts) {
        geminiCalls.json.push(opts);
        if (gemini.json instanceof Error) throw gemini.json;
        return { parsed: gemini.json || { is_home_time_request: false } };
      },
      async callGeminiText(opts) {
        geminiCalls.text.push(opts);
        return { text: gemini.text || 'A friendly bot note.' };
      },
    },
  };

  const telegram = {
    async sendMessage(chatId, text, extra) {
      sends.push({ chatId, text, extra });
      return { message_id: 555 };
    },
  };

  return {
    service: require(servicePath),
    telegram, inserts, sends, messageLinks, geminiCalls,
  };
}

const GROUP = { id: 7, telegram_group_id: '-1007', group_type: 'driver', group_name: 'WENZE UNIT # 96266 (COMPANY DRIVER)' };

test('classifyHomeTimeRequest: AI false → not a request', async () => {
  const { service } = loadService({ gemini: { json: { is_home_time_request: false, confidence: 'high', reason: 'oil change' } } });
  const verdict = await service.classifyHomeTimeRequest({ transcript: 'oil change talk', triggerText: 'need an oil change @tomr_robins0n' });
  assert.equal(verdict.isRequest, false);
  assert.equal(verdict.aiUsed, true);
});

test('classifyHomeTimeRequest: AI true (high) → request', async () => {
  const { service } = loadService({ gemini: { json: { is_home_time_request: true, confidence: 'high', reason: 'wants home' } } });
  const verdict = await service.classifyHomeTimeRequest({ transcript: 'driver wants to go home', triggerText: 'can he go home @tomr_robins0n' });
  assert.equal(verdict.isRequest, true);
  assert.equal(verdict.confidence, 'high');
});

test('classifyHomeTimeRequest: low-confidence yes with no home wording is suppressed', async () => {
  const { service } = loadService({ gemini: { json: { is_home_time_request: true, confidence: 'low', reason: 'maybe' } } });
  const verdict = await service.classifyHomeTimeRequest({ transcript: 'load issue', triggerText: 'check this load @tomr_robins0n' });
  assert.equal(verdict.isRequest, false);
});

test('classifyHomeTimeRequest: low-confidence yes WITH home wording is kept', async () => {
  const { service } = loadService({ gemini: { json: { is_home_time_request: true, confidence: 'low', reason: 'maybe' } } });
  const verdict = await service.classifyHomeTimeRequest({ transcript: '', triggerText: 'he wants to go home @tomr_robins0n' });
  assert.equal(verdict.isRequest, true);
});

test('classifyHomeTimeRequest: AI unavailable falls back to keyword heuristic', async () => {
  const fail = loadService({ gemini: { json: new Error('GEMINI_API_KEY is not configured') } });
  const yes = await fail.service.classifyHomeTimeRequest({ transcript: '', triggerText: 'driver wants home time @tomr_robins0n' });
  assert.equal(yes.isRequest, true);
  assert.equal(yes.aiUsed, false);

  const no = loadService({ gemini: { json: new Error('GEMINI_API_KEY is not configured') } });
  const verdict = await no.service.classifyHomeTimeRequest({ transcript: '', triggerText: 'need an oil change @tomr_robins0n' });
  assert.equal(verdict.isRequest, false);
  assert.equal(verdict.aiUsed, false);
});

test('handleApproverMention does NOT post a card when the AI says it is not a request', async () => {
  const { service, telegram, inserts, sends } = loadService({
    gemini: { json: { is_home_time_request: false, confidence: 'high', reason: 'oil change' } },
    transcript: '@rep: need an oil change',
  });
  await service.handleApproverMention(telegram, GROUP, {
    text: 'I think we gonna need an oil change @tomr_robins0n', from: { id: 1, username: 'rep' },
  });
  assert.equal(inserts.length, 0);
  assert.equal(sends.length, 0);
});

test('handleApproverMention posts a card and passes the trigger text to the AI when it IS a request', async () => {
  const { service, telegram, inserts, sends, messageLinks, geminiCalls } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', reason: 'wants home' } },
    transcript: '@rep: driver out 6 weeks',
  });
  await service.handleApproverMention(telegram, GROUP, {
    text: 'can he go home @tomr_robins0n', from: { id: 1, username: 'rep' },
  });
  assert.equal(inserts.length, 1);
  assert.equal(sends.length, 1);
  assert.equal(messageLinks.length, 1);
  // The actual triggering message text reaches the classifier prompt.
  assert.match(geminiCalls.json[0].userText, /can he go home @tomr_robins0n/);
  // Confidence is recorded with the stored reasoning.
  assert.match(inserts[0].aiReasoning, /confidence: high/);
});

test('handleApproverMention is a no-op when a pending request already exists', async () => {
  const { service, telegram, inserts, sends } = loadService({
    pending: { id: 1 },
    gemini: { json: { is_home_time_request: true, confidence: 'high' } },
  });
  await service.handleApproverMention(telegram, GROUP, { text: 'go home @tomr_robins0n', from: { id: 1 } });
  assert.equal(inserts.length, 0);
  assert.equal(sends.length, 0);
});
