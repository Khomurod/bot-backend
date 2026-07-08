/**
 * Higher-level service for the silent BOL/POD test monitor settings.
 *
 * Thin layer over database/bolPodMonitorSettings.js that the admin API uses:
 *   - getEffectiveSettings()  → DB-backed, cached, fail-safe (monitor hot path)
 *   - getStatus()             → settings + readiness (AI / Datatruck / upload mode)
 *   - sendTestMessage()       → post a probe message to the test group
 *   - checkGroupAccess()      → verify the bot can reach the test group
 *
 * DB is the source of truth — none of this reads Render env for the monitor
 * values. Errors are turned into clear, non-sensitive messages (never leak a
 * token, URL, or raw stack).
 */
const settingsDb = require('../database/bolPodMonitorSettings');
const config = require('../config/config');
const classifier = require('./documentClassifierService');
const datatruck = require('./datatruckApiService');
const { safeSend, isPermanentSendError } = require('./telegramHtml');

const TEST_MESSAGE = '✅ BOL/POD monitor test message. Bot can send to this group.';

function getEffectiveSettings() {
  return settingsDb.getEffectiveSettings();
}

function getSettingsForAdmin() {
  return settingsDb.getSettingsForAdmin();
}

function updateSettings(payload, updatedBy) {
  return settingsDb.updateSettings(payload, updatedBy);
}

function uploadMode() {
  if (config.datatruckDocUploadEnabled !== true) return 'off';
  return config.datatruckDocUploadDryRun ? 'dry_run' : 'live';
}

/** Settings + service readiness for the admin status panel. */
async function getStatus() {
  const settings = await settingsDb.getSettingsForAdmin();
  return {
    settings,
    aiClassifierConfigured: classifier.isConfigured(),
    datatruckConfigured: datatruck.isConfigured(),
    uploadMode: uploadMode(), // off | dry_run | live
    uploadPipelineEnabled: config.datatruckDocUploadEnabled === true,
  };
}

/** Turn a Telegram send error into a short, safe, actionable message. */
function friendlyError(err) {
  if (isPermanentSendError(err)) {
    return 'Bot cannot send to this test group. Add the bot to the group (and grant it send permission) or check the group ID.';
  }
  const desc = err?.response?.description || err?.message || 'Unknown error';
  return String(desc).slice(0, 200);
}

/**
 * Send a small probe message to the test group. `chatIdOverride` lets the admin
 * verify a candidate id before saving.
 */
async function sendTestMessage(telegram, chatIdOverride) {
  if (!telegram || typeof telegram.sendMessage !== 'function') {
    return { ok: false, error: 'Telegram client is not available on the server.' };
  }
  let chatId = chatIdOverride;
  if (chatId === undefined || chatId === null || chatId === '') {
    const s = await settingsDb.getSettingsForAdmin();
    chatId = s.testGroupId;
  }
  if (!chatId) return { ok: false, error: 'No test group ID configured. Set one before sending a test message.' };
  if (!settingsDb.isValidTelegramChatId(chatId)) {
    return { ok: false, chatId: String(chatId), error: 'test group ID is not a valid Telegram chat id.' };
  }
  try {
    await safeSend(() => telegram.sendMessage(String(chatId), TEST_MESSAGE, { parse_mode: 'HTML' }));
    return { ok: true, chatId: String(chatId), message: 'Test message sent to the test group.' };
  } catch (err) {
    return { ok: false, chatId: String(chatId), error: friendlyError(err) };
  }
}

/** Verify the bot can see/reach the test group (getChat). */
async function checkGroupAccess(telegram, chatIdOverride) {
  if (!telegram || typeof telegram.getChat !== 'function') {
    return { ok: false, error: 'Telegram client is not available on the server.' };
  }
  let chatId = chatIdOverride;
  if (chatId === undefined || chatId === null || chatId === '') {
    const s = await settingsDb.getSettingsForAdmin();
    chatId = s.testGroupId;
  }
  if (!chatId) return { ok: false, error: 'No test group ID configured.' };
  if (!settingsDb.isValidTelegramChatId(chatId)) {
    return { ok: false, chatId: String(chatId), error: 'test group ID is not a valid Telegram chat id.' };
  }
  try {
    const chat = await telegram.getChat(String(chatId));
    return { ok: true, chatId: String(chatId), title: chat?.title || null, type: chat?.type || null };
  } catch (err) {
    return { ok: false, chatId: String(chatId), error: friendlyError(err) };
  }
}

module.exports = {
  getEffectiveSettings,
  getSettingsForAdmin,
  updateSettings,
  getStatus,
  sendTestMessage,
  checkGroupAccess,
  uploadMode,
  TEST_MESSAGE,
};
