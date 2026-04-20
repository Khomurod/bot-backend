/**
 * Telegram Bot API "HTML" mode only allows a small tag subset.
 * Full HTML documents, <p>, nested markdown fences, etc. cause 400 parse errors.
 */

const TELEGRAM_HTML_MAX = 4096;

function stripMarkdownCodeFences(input) {
  let s = String(input || '');
  for (let i = 0; i < 25; i += 1) {
    const before = s;
    s = s.replace(/^\s*```(?:html|markdown|md|txt)?\s*/gim, '');
    s = s.replace(/\s*```\s*$/gim, '');
    s = s.replace(/```/g, '');
    if (s === before) break;
  }
  return s.trim();
}

/**
 * Reduce admin/AI HTML to something Telegram HTML parse_mode accepts.
 */
function sanitizeCompanyReportHtmlForTelegram(input) {
  let html = stripMarkdownCodeFences(input);

  html = html.replace(/<!DOCTYPE[^>]*>/gi, '');
  html = html.replace(/<\/?(?:html|head|body|meta|title|link|base)[^>]*>/gi, '');

  html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');

  html = html.replace(/<\/p>\s*<p[^>]*>/gi, '\n\n');
  html = html.replace(/<p[^>]*>/gi, '');
  html = html.replace(/<\/p>/gi, '\n');

  html = html.replace(/<br\s*\/?>/gi, '\n');

  html = html.replace(/<\/div>\s*<div[^>]*>/gi, '\n');
  html = html.replace(/<div[^>]*>/gi, '\n');
  html = html.replace(/<\/div>/gi, '\n');

  html = html.replace(/<\/?(?:section|article|header|footer|nav|main)[^>]*>/gi, '\n');

  html = html.replace(/<li[^>]*>/gi, '• ');
  html = html.replace(/<\/li>/gi, '\n');
  html = html.replace(/<\/?(?:ul|ol)[^>]*>/gi, '\n');

  html = html.replace(/<\/?(?:table|thead|tbody|tfoot|colgroup|col)[^>]*>/gi, '\n');
  html = html.replace(/<\/?(?:tr)[^>]*>/gi, '\n');
  html = html.replace(/<\/?(?:td|th)[^>]*>/gi, ' ');

  html = html.replace(/<\/h[1-6]>/gi, '\n\n');
  html = html.replace(/<h[1-6][^>]*>/gi, '\n<b>');
  html = html.replace(/<hr[^>]*>/gi, '\n---\n');

  html = html.replace(/<span(?![^>]*\btg-spoiler\b)[^>]*>/gi, '');
  html = html.replace(/<\/span>/gi, '');
  html = html.replace(/<font[^>]*>/gi, '');
  html = html.replace(/<\/font>/gi, '');
  html = html.replace(/<small[^>]*>/gi, '');
  html = html.replace(/<\/small>/gi, '');

  html = html.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '[$1]');
  html = html.replace(/<img[^>]*>/gi, '');

  html = html.replace(/\r\n/g, '\n');
  html = html.replace(/\n{3,}/g, '\n\n');

  return html.trim();
}

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
  stripMarkdownCodeFences,
  sanitizeCompanyReportHtmlForTelegram,
  sendTelegramHtmlChunks,
  safeSend,
  isPermanentSendError,
  TELEGRAM_HTML_MAX,
};
