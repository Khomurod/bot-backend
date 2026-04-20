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

/**
 * Split so each Telegram message stays within the 4096 limit.
 */
async function sendTelegramHtmlChunks(telegram, chatId, text, extra = {}) {
  const parts = splitHtmlForTelegram(text);
  if (parts.length === 0) return [];
  const messages = [];
  for (const body of parts) {
    messages.push(await telegram.sendMessage(chatId, body, { parse_mode: 'HTML', ...extra }));
  }
  return messages;
}

module.exports = {
  stripMarkdownCodeFences,
  sanitizeCompanyReportHtmlForTelegram,
  sendTelegramHtmlChunks,
  TELEGRAM_HTML_MAX,
};
