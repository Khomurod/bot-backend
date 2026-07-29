/**
 * Shared test harness for services/homeTimeRequestService — loads the service with
 * its DB / AI / Telegram / status / expiry deps mocked. Extracted so the several
 * request-service test files stay well under the file-size limit and share one
 * definition of the mocks (CLAUDE.md → reorganize oversized tests, never copy).
 */
const path = require('node:path');
const { DateTime } = require('luxon');

// Dates relative to "now" so the window-reasonableness checks (which use the real
// clock) always accept them, regardless of when the suite runs.
const TODAY = DateTime.now().setZone('America/Chicago');
const FROM = TODAY.plus({ days: 3 }).toISODate();
const TO = TODAY.plus({ days: 7 }).toISODate(); // 4 days after FROM (return-to-road)
const LAST_DAY = TODAY.plus({ days: 6 }).toISODate(); // last day home = return − 1
// Completed request cards go here, NEVER to the driver's group (GROUP below).
const NOTIFY_GROUP_ID = '-1009999';
// Internal staff group for clarification alerts while driver messaging is off.
const INTERNAL_GROUP_ID = '-1008888';

const GROUP = { id: 7, telegram_group_id: '-1007', group_type: 'driver', group_name: 'WENZE UNIT # 96266 (COMPANY DRIVER)' };

/** camelCase insert payload → the snake_case row shape `RETURNING *` produces. */
function toRowShape(payload = {}) {
  const row = {};
  for (const [key, value] of Object.entries(payload)) {
    row[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = value;
  }
  return row;
}

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
  notifyGroupId = NOTIFY_GROUP_ID, // completed-request notification group (null = unconfigured)
  approvedRequest = null, // getApprovedHomeTimeRequestForGroup (an already-registered window)
  driverMessaging = true, // home_time_settings.driver_clarification_enabled
  internalGroupId = INTERNAL_GROUP_ID, // internal_clarification_group_id (null = unconfigured)
} = {}) {
  const servicePath = path.resolve(__dirname, '../../services/homeTimeRequestService.js');
  const dbPath = path.resolve(__dirname, '../../database/db.js');
  const htPath = path.resolve(__dirname, '../../database/homeTime.js');
  const htmlPath = path.resolve(__dirname, '../../services/telegramHtml.js');
  const bufferPath = path.resolve(__dirname, '../../services/recentMessageBuffer.js');
  const geminiPath = path.resolve(__dirname, '../../services/geminiClient.js');
  const intentPath = path.resolve(__dirname, '../../services/homeTimeIntentService.js');
  const statusPath = path.resolve(__dirname, '../../services/homeTimeService.js');
  const configPath = path.resolve(__dirname, '../../config/config.js');
  const htExpiryPath = path.resolve(__dirname, '../../database/homeTimeExpiry.js');
  // homeTimeApproval must be re-required so it re-binds the mocked expiry DB layer
  // below (its `htExpiry`/`ht` references are captured at load time).
  const approvalPath = path.resolve(__dirname, '../../services/homeTimeApproval.js');
  // The modules the orchestrator was split into capture `ht`/`db`/telegram helpers
  // at load time too, so every one of them must be re-required against the mocks
  // below. Forgetting one leaves a stale binding and the flow silently no-ops.
  const flowPath = path.resolve(__dirname, '../../services/homeTimeClarificationFlow.js');
  const composerPath = path.resolve(__dirname, '../../services/homeTimeMessageComposer.js');
  const channelPath = path.resolve(__dirname, '../../services/homeTimeDriverChannel.js');
  const internalAlertPath = path.resolve(__dirname, '../../services/homeTimeInternalAlert.js');
  const approverTagPath = path.resolve(__dirname, '../../services/homeTimeApproverTag.js');

  for (const p of [servicePath, dbPath, htPath, htmlPath, bufferPath, geminiPath, intentPath,
    statusPath, configPath, htExpiryPath, approvalPath, flowPath, composerPath, channelPath,
    internalAlertPath, approverTagPath]) {
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
  const expiries = [];
  const internalClaims = [];

  require.cache[htExpiryPath] = {
    exports: {
      async listOpenHomeTimeRequests() { return []; },
      async expireOutdatedHomeTimeRequest(id) {
        expiries.push(id);
        const row = [open, clarification].find((r) => r && r.id === id);
        return row ? { ...row, status: 'expired', next_reminder_at: null } : { id, status: 'expired' };
      },
    },
  };

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
          completed_notify_group_id: notifyGroupId,
          driver_clarification_enabled: driverMessaging,
          internal_clarification_group_id: internalGroupId,
        };
      },
      async getDriverHomeStatus() { return homeStatus; },
      async getOpenHomeStay() { return openStay; },
      async findDecidedRequestNearDate() { return null; },
      async getApprovedHomeTimeRequestForGroup() { return approvedRequest; },
      async insertHomeTimeRequest(payload) {
        inserts.push(payload);
        // Production runs `INSERT ... RETURNING *`, so the returned row is the
        // DATABASE shape (snake_case), not the camelCase payload. Mirror that —
        // callers such as the internal alert read request.driver_name.
        return { id: 99, ...payload, ...toRowShape(payload) };
      },
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
      // Atomic internal-alert claim: the first caller for an id wins, matching
      // the real `WHERE internal_alert_sent_at IS NULL` guard.
      async claimInternalClarificationAlert(id) {
        if (internalClaims.includes(id)) return null;
        internalClaims.push(id);
        return { id };
      },
      async releaseInternalClarificationAlert(id) {
        const i = internalClaims.indexOf(id);
        if (i >= 0) internalClaims.splice(i, 1);
        return { id };
      },
    },
  };
  require.cache[htmlPath] = { exports: { safeSend: async (fn) => fn() } };
  require.cache[bufferPath] = { exports: { renderTranscript() { return transcript; } } };
  const stateTransitions = [];
  require.cache[statusPath] = {
    exports: {
      async applyStateTransition(_telegram, _group, payload) { stateTransitions.push(payload); return null; },
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

  const edits = [];
  const telegram = {
    async sendMessage(chatId, text, extra) { sends.push({ chatId, text, extra }); return { message_id: 555 }; },
    async setMessageReaction(chatId, messageId, reaction) { reactions.push({ chatId, messageId, reaction }); },
    async editMessageText(...args) { edits.push(args); },
  };

  return {
    service: require(servicePath), telegram,
    inserts, sends, messageLinks, fulfills, updates, clarMsgs, reactions, geminiCalls, stateTransitions, expiries, edits,
    internalClaims,
    // Messages split by destination, so a test can assert "nothing reached the
    // driver" without re-deriving chat ids.
    driverSends: () => sends.filter((m) => String(m.chatId) === String(GROUP.telegram_group_id)),
    internalSends: () => sends.filter((m) => String(m.chatId) === String(INTERNAL_GROUP_ID)),
    notifySends: () => sends.filter((m) => String(m.chatId) === String(notifyGroupId)),
  };
}

module.exports = {
  TODAY, FROM, TO, LAST_DAY, NOTIFY_GROUP_ID, INTERNAL_GROUP_ID, GROUP, loadService,
};
