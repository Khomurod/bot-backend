/**
 * Finance Monitor settings — single-row store (id = 1).
 *
 * Backs Settings → Finance. OFF by default and off means off: nothing is read
 * from any chat until an administrator enables the feature AND a group has been
 * validated. An integration that switches itself on at deploy starts reading a
 * chat nobody agreed to read, and this one reads payment messages.
 *
 * No secrets here. Telegram chat ids are not secrets and are returned as they
 * are stored; every write is parameterised and clamped against the CHECKs in
 * migration 0052.
 *
 * A DATABASE OUTAGE IS NOT "NOTHING CONFIGURED", AND THIS MODULE DOES NOT SAY
 * IT IS. Six older settings modules catch every error from their single-row
 * read and return null, on the reasoning that the table may not exist yet on a
 * fresh database before migrations ran. That is true of exactly ONE error —
 * 42P01, undefined_table — and collapsing the rest into it means a transient
 * outage reads as "the operator turned this off". Here only 42P01 answers
 * "not set up yet"; everything else is rethrown, so a caller that cannot
 * tolerate uncertainty can say so instead of quietly capturing nothing.
 * See lib/database/failureClassification.js for the vocabulary.
 */
const { query } = require('./db');

const CACHE_TTL_MS = 30_000;
let cache = null;
let cacheExpiresAt = 0;

/** Postgres: the relation does not exist. The one honest "not set up yet". */
const UNDEFINED_TABLE = '42P01';

/** A user-input validation failure; the route maps this to HTTP 400. */
class FinanceSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FinanceSettingsError';
    this.statusCode = 400;
  }
}

function invalidateCache() {
  cache = null;
  cacheExpiresAt = 0;
}

async function getSettingsRow() {
  try {
    const { rows } = await query('SELECT * FROM finance_settings WHERE id = 1');
    return rows[0] || null;
  } catch (err) {
    if (err && err.code === UNDEFINED_TABLE) {
      // A brand-new database before initializeDatabase ran. "Nothing
      // configured" is the truth here, and only here.
      console.warn('[FINANCE SETTINGS] finance_settings does not exist yet.');
      return null;
    }
    throw err;
  }
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normaliseChatId(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

/**
 * The settings as the application should act on them.
 *
 * `chatId` falls back to FINANCE_GROUP_CHAT_ID when the column is NULL — the
 * house rule that a NULL column inherits the environment. `enabled` does NOT
 * inherit anything: an env var must never be able to switch this on.
 */
function shape(row) {
  const envChat = normaliseChatId(process.env.FINANCE_GROUP_CHAT_ID);
  return {
    enabled: Boolean(row?.enabled),
    chatId: normaliseChatId(row?.chat_id) || envChat,
    chatTitle: row?.chat_title || null,
    chatValidatedAt: row?.chat_validated_at || null,
    captureDocuments: Boolean(row?.capture_documents),
    aiReadingEnabled: Boolean(row?.ai_reading_enabled),
    maxDocumentMb: clampInt(row?.max_document_mb, 8, 1, 20),
    duplicateWindowHours: clampInt(row?.duplicate_window_hours, 72, 1, 8760),
    weeklyReportEnabled: Boolean(row?.weekly_report_enabled),
    weeklyReportChatId: normaliseChatId(row?.weekly_report_chat_id),
    enabledAt: row?.enabled_at || null,
    updatedAt: row?.updated_at || null,
  };
}

/** Cached read. Throws on a real database failure; see the header. */
async function getFinanceSettings() {
  const now = Date.now();
  if (cache && now < cacheExpiresAt) return cache;
  cache = shape(await getSettingsRow());
  cacheExpiresAt = now + CACHE_TTL_MS;
  return cache;
}

/**
 * Is this the chat the Finance Monitor was pointed at?
 *
 * The capture handler asks this about EVERY message the bot sees, so it has to
 * be cheap (it is, behind the 30s cache) and it has to be certain: an
 * unconfigured or switched-off monitor must answer false for every chat rather
 * than "probably not this one".
 */
async function isFinanceChat(chatId) {
  const settings = await getFinanceSettings();
  if (!settings.enabled) return false;
  if (!settings.chatId) return false;
  return String(chatId) === String(settings.chatId);
}

/**
 * Save. Omitted fields keep their stored value — the house omit-means-keep
 * rule — and `enabled` cannot be turned on without a validated chat, because
 * capturing from a group nobody confirmed is the mistake this feature must not
 * make.
 */
async function updateFinanceSettings(patch = {}, adminId = null) {
  const current = await getSettingsRow();
  const next = {
    enabled: patch.enabled === undefined ? Boolean(current?.enabled) : Boolean(patch.enabled),
    chat_id: patch.chatId === undefined ? (current?.chat_id ?? null) : normaliseChatId(patch.chatId),
    chat_title: patch.chatTitle === undefined ? (current?.chat_title ?? null) : (patch.chatTitle || null),
    chat_validated_at: patch.chatValidatedAt === undefined
      ? (current?.chat_validated_at ?? null)
      : (patch.chatValidatedAt || null),
    capture_documents: patch.captureDocuments === undefined
      ? Boolean(current?.capture_documents)
      : Boolean(patch.captureDocuments),
    ai_reading_enabled: patch.aiReadingEnabled === undefined
      ? Boolean(current?.ai_reading_enabled)
      : Boolean(patch.aiReadingEnabled),
    max_document_mb: clampInt(
      patch.maxDocumentMb === undefined ? current?.max_document_mb : patch.maxDocumentMb, 8, 1, 20,
    ),
    duplicate_window_hours: clampInt(
      patch.duplicateWindowHours === undefined ? current?.duplicate_window_hours : patch.duplicateWindowHours,
      72, 1, 8760,
    ),
    weekly_report_enabled: patch.weeklyReportEnabled === undefined
      ? Boolean(current?.weekly_report_enabled)
      : Boolean(patch.weeklyReportEnabled),
    weekly_report_chat_id: patch.weeklyReportChatId === undefined
      ? (current?.weekly_report_chat_id ?? null)
      : normaliseChatId(patch.weeklyReportChatId),
  };

  if (next.enabled && !(next.chat_id && next.chat_validated_at)) {
    throw new FinanceSettingsError(
      'Validate the finance group before switching the Finance Monitor on.',
    );
  }

  // Stamped the first time it is switched on, and never moved afterwards: the
  // weekly report uses it to tell "no money codes that week" from "we were not
  // watching that week", which are opposite answers.
  const enabledAt = next.enabled
    ? (current?.enabled_at || new Date())
    : (current?.enabled_at || null);

  const { rows } = await query(
    `UPDATE finance_settings
        SET enabled = $1, chat_id = $2, chat_title = $3, chat_validated_at = $4,
            capture_documents = $5, ai_reading_enabled = $6, max_document_mb = $7,
            duplicate_window_hours = $8, weekly_report_enabled = $9,
            weekly_report_chat_id = $10, enabled_at = $11,
            updated_at = NOW(), updated_by = $12
      WHERE id = 1
      RETURNING *`,
    [
      next.enabled, next.chat_id, next.chat_title, next.chat_validated_at,
      next.capture_documents, next.ai_reading_enabled, next.max_document_mb,
      next.duplicate_window_hours, next.weekly_report_enabled,
      next.weekly_report_chat_id, enabledAt, adminId,
    ],
  );

  invalidateCache();
  return shape(rows[0] || null);
}

module.exports = {
  FinanceSettingsError,
  getFinanceSettings,
  isFinanceChat,
  updateFinanceSettings,
  invalidateCache,
  __shapeForTests: shape,
};
