const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DateTime } = require('luxon');

// Dates relative to "now" so the window-reasonableness checks (which use the real
// clock) always accept them, regardless of when the suite runs.
const TODAY = DateTime.now().setZone('America/Chicago');
const FROM = TODAY.plus({ days: 3 }).toISODate();
const TO = TODAY.plus({ days: 7 }).toISODate(); // 4 days after FROM (return-to-road)
const LAST_DAY = TODAY.plus({ days: 6 }).toISODate(); // last day home = return − 1

/**
 * Load homeTimeRequestService with its DB / AI / Telegram / status deps mocked.
 * `gemini.json` controls callGeminiJson; `gemini.text` controls callGeminiText
 * (an Error there forces the deterministic fallback message).
 */
function loadService({
  gemini = {},
  open = null, // getOpenHomeTimeRequestForGroup
  clarification = null, // getOpenClarificationForGroup
  homeStatus = { state: 'road', state_since: DateTime.now().minus({ days: 40 }).toUTC().toISO() },
  openStay = { road_started_at: DateTime.now().minus({ days: 40 }).toUTC().toISO(), days_on_road: 40 },
  profile = {
    first_name: 'Pascal', last_name: 'F', unit_number: '96266', driver_type: 'company_driver',
    telegram_user_id: '900',
  },
  ack = { id: 99 }, // markHomeTimeAcknowledged (claim wins by default)
  transcript = '',
} = {}) {
  const servicePath = path.resolve(__dirname, '../services/homeTimeRequestService.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const htPath = path.resolve(__dirname, '../database/homeTime.js');
  const htmlPath = path.resolve(__dirname, '../services/telegramHtml.js');
  const bufferPath = path.resolve(__dirname, '../services/recentMessageBuffer.js');
  const geminiPath = path.resolve(__dirname, '../services/geminiClient.js');
  const intentPath = path.resolve(__dirname, '../services/homeTimeIntentService.js');
  const statusPath = path.resolve(__dirname, '../services/homeTimeService.js');
  const configPath = path.resolve(__dirname, '../config/config.js');

  for (const p of [servicePath, dbPath, htPath, htmlPath, bufferPath, geminiPath, intentPath, statusPath, configPath]) {
    delete require.cache[p];
  }

  require.cache[configPath] = { exports: { employeeGroupId: '' } };

  const inserts = [];
  const sends = [];
  const messageLinks = [];
  const fulfills = [];
  const updates = [];
  const clarMsgs = [];
  const reactions = [];

  require.cache[dbPath] = {
    exports: { async getDriverProfileByGroupId() { return profile; } },
  };
  require.cache[htPath] = {
    exports: {
      async getOpenHomeTimeRequestForGroup() { return open; },
      async getOpenClarificationForGroup() { return clarification; },
      async getAwaitingDatesHomeTimeRequestForGroup() { return clarification; },
      async getHomeTimeSettings() {
        return {
          road_allowance_weeks: 4, home_allowance_days: 4, reminder_first_hours: 12, reminder_second_hours: 12,
        };
      },
      async getDriverHomeStatus() { return homeStatus; },
      async getOpenHomeStay() { return openStay; },
      async findDecidedRequestNearDate() { return null; },
      async insertHomeTimeRequest(payload) { inserts.push(payload); return { id: 99, ...payload }; },
      async updateHomeTimeRequestFields(id, patch) { updates.push({ id, patch }); return { id, ...patch }; },
      async fulfillAwaitingHomeTimeRequest(id, payload) {
        fulfills.push({ id, payload });
        return { id, status: 'pending', ...payload };
      },
      async setHomeTimeRequestMessage(id, chatId, messageId) {
        messageLinks.push({ id, chatId, messageId });
        return { id };
      },
      async setHomeTimeClarificationMessage(id, payload) { clarMsgs.push({ id, payload }); return { id }; },
      async markHomeTimeAcknowledged(id) { return ack; },
    },
  };
  require.cache[htmlPath] = { exports: { safeSend: async (fn) => fn() } };
  require.cache[bufferPath] = { exports: { renderTranscript() { return transcript; } } };
  require.cache[statusPath] = {
    exports: {
      async applyStateTransition() { return null; },
      async closeHomeStayOnReturn() { return null; },
    },
  };

  const geminiCalls = { json: [], text: [] };
  require.cache[geminiPath] = {
    exports: {
      async callGeminiJson(opts) {
        geminiCalls.json.push(opts);
        if (gemini.json instanceof Error) throw gemini.json;
        if (Array.isArray(gemini.json)) {
          const next = gemini.json.shift();
          if (next instanceof Error) throw next;
          return { parsed: next };
        }
        return { parsed: gemini.json || { is_home_time_request: false } };
      },
      async callGeminiText(opts) {
        geminiCalls.text.push(opts);
        if (gemini.text instanceof Error) throw gemini.text;
        return { text: gemini.text || 'A friendly bot note.' };
      },
    },
  };
  // Real intent service, but with the mocked gemini client above.
  delete require.cache[intentPath];

  const telegram = {
    async sendMessage(chatId, text, extra) { sends.push({ chatId, text, extra }); return { message_id: 555 }; },
    async setMessageReaction(chatId, messageId, reaction) { reactions.push({ chatId, messageId, reaction }); },
  };

  return {
    service: require(servicePath), telegram,
    inserts, sends, messageLinks, fulfills, updates, clarMsgs, reactions, geminiCalls,
  };
}

const GROUP = { id: 7, telegram_group_id: '-1007', group_type: 'driver', group_name: 'WENZE UNIT # 96266 (COMPANY DRIVER)' };

// ── legacy classifier (unchanged contract) ──

test('classifyHomeTimeRequest: AI false → not a request', async () => {
  const { service } = loadService({ gemini: { json: { is_home_time_request: false, confidence: 'high', reason: 'oil change' } } });
  const v = await service.classifyHomeTimeRequest({ transcript: 'oil change', triggerText: 'need an oil change @tomr_robins0n' });
  assert.equal(v.isRequest, false);
});

test('classifyHomeTimeRequest: request with valid dates is extracted', async () => {
  const { service } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: true, home_from: FROM, home_to: LAST_DAY } },
  });
  const v = await service.classifyHomeTimeRequest({ triggerText: `home ${FROM} to ${LAST_DAY} @tomr_robins0n` });
  assert.equal(v.isRequest, true);
  assert.equal(v.datesSpecified, true);
});

// ── handleApproverMention ──

test('approver tag, not a request → no card, no clarification', async () => {
  const { service, telegram, inserts, sends } = loadService({
    gemini: { json: { is_home_time_request: false, confidence: 'high', reason: 'oil change' } },
  });
  await service.handleApproverMention(telegram, GROUP, { message_id: 10, text: 'oil change @tomr_robins0n', from: { id: 1 } });
  assert.equal(inserts.length, 0);
  assert.equal(sends.length, 0);
});

test('approver tag WITH dates posts the approval card immediately', async () => {
  const { service, telegram, inserts, sends, messageLinks } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: true, home_from: FROM, home_to: LAST_DAY } },
  });
  await service.handleApproverMention(telegram, GROUP, { message_id: 10, text: `home ${FROM} to ${LAST_DAY} @tomr_robins0n`, from: { id: 1, username: 'rep' } });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].status, 'pending');
  assert.equal(inserts[0].homeFrom, FROM);
  assert.equal(inserts[0].returnToRoadDate, TO); // last-day-home + 1
  assert.equal(sends.length, 1);
  assert.ok(sends[0].extra?.reply_markup, 'card carries inline buttons');
  assert.equal(messageLinks.length, 1);
});

test('approver tag WITHOUT dates opens a clarification, replying to the tag message', async () => {
  const { service, telegram, inserts, sends, clarMsgs } = loadService({
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: false }, text: new Error('force fallback') },
  });
  await service.handleApproverMention(telegram, GROUP, { message_id: 42, text: 'he wants to go home @tomr_robins0n', from: { id: 1 } });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].status, 'awaiting_dates');
  assert.equal(inserts[0].rootMessageId, 42);
  assert.ok(inserts[0].nextReminderAt, 'first reminder scheduled');
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /dates/i);
  assert.equal(sends[0].extra?.reply_to_message_id, 42, 'clarification replies to the tag message');
  assert.equal(clarMsgs.length, 1);
});

test('approver tag is a no-op when an open request already exists', async () => {
  const { service, telegram, inserts, sends } = loadService({
    open: { id: 1, status: 'awaiting_dates' },
    gemini: { json: { is_home_time_request: true, confidence: 'high' } },
  });
  await service.handleApproverMention(telegram, GROUP, { message_id: 1, text: 'go home @tomr_robins0n', from: { id: 1 } });
  assert.equal(inserts.length, 0);
  assert.equal(sends.length, 0);
});

test('approver tag while already home → no card (unplanned flow handles that)', async () => {
  const { service, telegram, inserts, sends, geminiCalls } = loadService({
    homeStatus: { state: 'home', state_since: TODAY.minus({ days: 1 }).toUTC().toISO() },
    gemini: { json: { is_home_time_request: true, confidence: 'high', dates_specified: true, home_from: FROM, home_to: LAST_DAY } },
  });
  await service.handleApproverMention(telegram, GROUP, { message_id: 1, text: `home ${FROM} to ${LAST_DAY} @tomr_robins0n`, from: { id: 1 } });
  assert.equal(inserts.length, 0);
  assert.equal(sends.length, 0);
  assert.equal(geminiCalls.json.length, 0, 'short-circuits before AI');
});

// ── handleActualHomeArrival (Status: Home without an earlier request) ──

test('Status: Home with no earlier request asks ONLY for the return-to-road date, replying to it', async () => {
  const homeStartIso = TODAY.toUTC().toISO();
  const { service, telegram, inserts, sends } = loadService({
    open: null, homeStatus: { state: 'home', state_since: homeStartIso },
    gemini: { text: new Error('force fallback') },
  });
  await service.handleActualHomeArrival(telegram, GROUP, { message_id: 77, text: 'Status: Home', from: { id: 900 } }, { homeStartIso });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].status, 'awaiting_return_to_road');
  assert.equal(inserts[0].isUnplannedArrival, true);
  assert.equal(inserts[0].homeFrom, TODAY.toISODate()); // home start = the Status: Home date
  assert.equal(inserts[0].returnToRoadDate, null); // never fabricated
  assert.equal(inserts[0].rootMessageId, 77);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].extra?.reply_to_message_id, 77);
  assert.match(sends[0].text, /back on the road/i);
});

test('Status: Home does NOT re-ask when a complete request already exists (no duplicate)', async () => {
  const { service, telegram, inserts, sends } = loadService({
    open: { id: 5, status: 'pending', home_from: FROM, return_to_road_date: TO },
  });
  await service.handleActualHomeArrival(telegram, GROUP, { message_id: 77, text: 'Status: Home', from: { id: 900 } }, { homeStartIso: TODAY.toUTC().toISO() });
  assert.equal(inserts.length, 0);
  assert.equal(sends.length, 0);
});

// ── handleHomeTimeClarificationReply (plain-text follow-up) ──

test('driver answers the return date (no Telegram reply) → completes + posts card + 👍 ack', async () => {
  const { service, telegram, fulfills, sends, reactions } = loadService({
    clarification: { id: 42, status: 'awaiting_return_to_road', home_from: FROM, return_to_road_date: null, language: 'en' },
    gemini: {
      json: {
        intent: 'home_time_followup', confidence: 90, isActualStatusChange: false,
        requestedHomeTime: false, returnToRoadDate: TO,
      },
      text: 'Awesome, noted.',
    },
    // Compliant: 40 days on road, 4 home days.
    homeStatus: { state: 'home', state_since: TODAY.toUTC().toISO() },
    openStay: { road_started_at: TODAY.minus({ days: 40 }).toUTC().toISO(), days_on_road: 40 },
  });
  await service.handleHomeTimeClarificationReply(telegram, GROUP, { message_id: 88, text: `back on the road ${TO}`, from: { id: 900, username: 'driver' } });
  assert.equal(fulfills.length, 1);
  assert.equal(fulfills[0].payload.returnToRoadDate, TO);
  // one card + one ack message
  assert.ok(sends.length >= 2, 'card and acknowledgment both sent');
  assert.ok(sends.some((s) => s.extra?.reply_markup), 'approval card posted');
  assert.equal(reactions.length, 1, 'compliant → 👍 reaction');
});

test('over-home window → firm policy reminder, NO 👍', async () => {
  const longReturn = TODAY.plus({ days: 10 }).toISODate(); // ~10 home days > 4
  const { service, telegram, fulfills, sends, reactions } = loadService({
    clarification: { id: 42, status: 'awaiting_return_to_road', home_from: TODAY.toISODate(), return_to_road_date: null },
    gemini: {
      json: {
        intent: 'home_time_followup', confidence: 90, isActualStatusChange: false, returnToRoadDate: longReturn,
      },
      text: new Error('force fallback'),
    },
    homeStatus: { state: 'home', state_since: TODAY.toUTC().toISO() },
    openStay: { road_started_at: TODAY.minus({ days: 40 }).toUTC().toISO(), days_on_road: 40 },
  });
  await service.handleHomeTimeClarificationReply(telegram, GROUP, { message_id: 88, text: `back ${longReturn}`, from: { id: 900 } });
  assert.equal(fulfills.length, 1);
  assert.equal(reactions.length, 0, 'not compliant → no 👍');
  assert.ok(sends.some((s) => /4 weeks on the road/i.test(s.text)), 'firm policy reminder sent');
});

test('unrelated plain text is NOT consumed as an answer', async () => {
  const { service, telegram, fulfills, sends } = loadService({
    clarification: { id: 42, status: 'awaiting_return_to_road', home_from: FROM },
    gemini: { json: { intent: 'unrelated', confidence: 95, isActualStatusChange: false } },
  });
  await service.handleHomeTimeClarificationReply(telegram, GROUP, { message_id: 88, text: 'ok thanks boss', from: { id: 900 } });
  assert.equal(fulfills.length, 0);
  assert.equal(sends.length, 0);
});

test('no open clarification → follow-up handler is a no-op', async () => {
  const { service, telegram, fulfills } = loadService({ clarification: null });
  await service.handleHomeTimeClarificationReply(telegram, GROUP, { message_id: 88, text: `back ${TO}`, from: { id: 900 } });
  assert.equal(fulfills.length, 0);
});

// ── processHomeTimeMessage orchestration ──

test('orchestrator: road→home transition triggers the unplanned-arrival ask', async () => {
  const homeStartIso = TODAY.toUTC().toISO();
  const { service, telegram, inserts } = loadService({ open: null, homeStatus: { state: 'home', state_since: homeStartIso }, gemini: { text: new Error('fb') } });
  await service.processHomeTimeMessage(telegram, GROUP, { message_id: 77, text: 'Status: Home', from: { id: 900 } }, {
    statusResult: { transition: 'road_to_home', eventAt: homeStartIso },
    mentionsApprover: false,
  });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].status, 'awaiting_return_to_road');
});

test('orchestrator: repeated same-status line does nothing conversational', async () => {
  const { service, telegram, inserts, sends } = loadService({});
  await service.processHomeTimeMessage(telegram, GROUP, { message_id: 1, text: 'Status: Home', from: { id: 900 } }, {
    statusResult: { changed: false, transition: null, eventAt: TODAY.toUTC().toISO() },
    mentionsApprover: false,
  });
  assert.equal(inserts.length, 0);
  assert.equal(sends.length, 0);
});
