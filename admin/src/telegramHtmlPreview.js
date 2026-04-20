/**
 * Client-side preview sanitizer for AI company reports.
 * Keep logic aligned with ../services/telegramHtml.js (sanitizeCompanyReportHtmlForTelegram).
 * Vite cannot reliably consume the server's CommonJS module in the browser bundle.
 */

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

export function sanitizeCompanyReportHtmlForTelegram(input) {
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
