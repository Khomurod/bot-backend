/**
 * Telegram Bot API "HTML" mode only allows a small tag subset.
 * Full HTML documents, <p>, nested markdown fences, etc. cause 400 parse errors.
 */

const TELEGRAM_HTML_MAX = 4096;

function splitHtmlForTelegram(text) {
  const max = TELEGRAM_HTML_MAX;
  const raw = String(text || '');
  if (!raw) return [];

  const rough = [];
  let rest = raw;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = max;
    rough.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) rough.push(rest);

  const out = [];
  for (let piece of rough) {
    if (piece.length <= max) {
      out.push(piece);
      continue;
    }
    let plain = piece.replace(/<[^>]+>/g, '');
    while (plain.length > max) {
      out.push(plain.slice(0, max));
      plain = plain.slice(max);
    }
    if (plain.length) out.push(plain);
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Heuristic to decide if a Telegram API error is a hard/permanent delivery
 * failure (chat gone, bot kicked, deactivated) vs a transient failure worth
 * retrying.
 */
function isPermanentSendError(err) {
  const code = err?.response?.error_code;
  const desc = String(err?.response?.description || '').toLowerCase();
  if (code === 403) return true;
  if (code === 400 && desc.includes('chat not found')) return true;
  if (code === 400 && desc.includes('group chat was deactivated')) return true;
  if (code === 400 && desc.includes('chat was upgraded')) return true;
  return false;
}

/**
 * Call a Telegram Bot API send function with 429-aware retries and
 * exponential backoff on transient failures. Permanent errors bubble up
 * immediately so callers can deactivate stale groups without waiting.
 *
 * @param {Function} sendFn  async zero-arg function performing the send.
 * @param {object}   [opts]
 * @param {number}   [opts.maxAttempts=4]
 * @param {number}   [opts.baseDelayMs=500]
 * @returns {Promise<any>} result of sendFn
 */
async function safeSend(sendFn, opts = {}) {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
  const baseDelayMs = Math.max(50, opts.baseDelayMs ?? 500);
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await sendFn();
    } catch (err) {
      lastErr = err;
      if (isPermanentSendError(err)) throw err;

      if (err?.response?.error_code === 429) {
        const retryAfter = Number(err.response?.parameters?.retry_after) || 1;
        await sleep(Math.min(retryAfter * 1000 + 250, 30000));
        continue;
      }

      if (attempt === maxAttempts) break;
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 30000);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Split so each Telegram message stays within the 4096 limit, and send
 * each chunk through `safeSend` for 429/backoff safety.
 */
async function sendTelegramHtmlChunks(telegram, chatId, text, extra = {}) {
  const parts = splitHtmlForTelegram(text);
  if (parts.length === 0) return [];
  const messages = [];
  for (const body of parts) {
    const sent = await safeSend(() =>
      telegram.sendMessage(chatId, body, { parse_mode: 'HTML', ...extra })
    );
    messages.push(sent);
  }
  return messages;
}

module.exports = {
  sendTelegramHtmlChunks,
  safeSend,
  isPermanentSendError,
  TELEGRAM_HTML_MAX,
};
