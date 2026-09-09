/**
 * Turning a Telegram API rejection into text that is safe to show an admin.
 *
 * Pure. Telegraf hangs the bot token off some error shapes and repeats it in
 * request URLs, so every message that reaches a response body or a log line goes
 * through here first — the settings screens exist to configure credentials, and a
 * validation failure must never be the thing that prints one.
 */

/** Strip any bot-token-looking substring and cap the length. */
function cleanTelegramError(err) {
  const desc = err?.response?.description || err?.description || err?.message || 'unknown error';
  return String(desc).replace(/bot\d+:[A-Za-z0-9_-]+/gi, 'bot***').slice(0, 300);
}

module.exports = { cleanTelegramError };
