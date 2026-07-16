/**
 * Route Control error construction and Telegram failure classification.
 *
 * Pure: no Telegram requests, no DB. `serviceError` is the single place a Route
 * Control error gets its stable `code` + HTTP `status`, so the Admin API's error
 * contract is defined in one file.
 */
const { classifyTelegramError } = require('../telegramEdit');

/**
 * Build a Route Control service error carrying a stable machine-readable `code`
 * and the HTTP `status` the Admin API should answer with.
 */
function serviceError(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

/**
 * PURE. Classify a Telegram sendPhoto failure into a safe, admin-readable
 * reason string (no tokens, no internal stack traces). 403 = bot permission /
 * group access; 413 or size wording = file too large; 400 = rejected payload;
 * timeouts are called out so a retry is the obvious next step.
 */
function classifyTelegramPhotoError(err) {
  const code = err?.response?.error_code;
  const desc = String(err?.response?.description || err?.message || '').slice(0, 160);
  if (code === 403) return 'TELEGRAM_PHOTO_REJECTED: the bot lacks permission in the driver group (403)';
  if (code === 413 || /too large|too big|entity too large/i.test(desc)) {
    return 'TELEGRAM_PHOTO_REJECTED: the file is too large for Telegram (413)';
  }
  if (code === 400) return `TELEGRAM_PHOTO_REJECTED: Telegram rejected the photo (400${desc ? ` — ${desc}` : ''})`;
  if (/timeout|timed out|etimedout|esockettimedout|econnreset|network/i.test(desc)) {
    return 'TELEGRAM_PHOTO_TIMEOUT';
  }
  return `TELEGRAM_PHOTO_SEND_FAILED${desc ? `: ${desc}` : ''}`;
}

/**
 * PURE. Stable string code for a Telegram edit failure — a thin wrapper over the
 * ONE canonical classifier in services/telegramEdit.js (kept for callers that
 * only need the code). NOT_MODIFIED is treated as success by callers.
 */
function classifyTelegramEditError(err) {
  return classifyTelegramError(err).code;
}

module.exports = {
  serviceError,
  classifyTelegramPhotoError,
  classifyTelegramEditError,
};
