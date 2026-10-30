/**
 * Client-side sanitizer for the live Telegram HTML previews (the broadcast
 * composer's preview): what Telegram would render, and nothing that could run
 * in the admin panel's origin.
 */

// ─── Allow-list sanitizer for live Telegram HTML previews ───────────────
// Admin-entered broadcast text is rendered via dangerouslySetInnerHTML so
// operators can see bold/italic/links styled the same way Telegram will
// render them. An admin account is trusted, but still — defense in depth:
// we strip anything that Telegram wouldn't render anyway (scripts, styles,
// images, forms, iframes, event-handler attributes) so a copy-pasted
// payload can't execute in the admin panel's origin. We also restrict
// anchor href schemes to http/https/mailto/tg so `javascript:` URLs never
// make it into the live DOM.
const TELEGRAM_ALLOWED_TAGS = new Set([
  'b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del',
  'code', 'pre', 'a', 'br', 'blockquote', 'tg-spoiler', 'span',
]);
const SAFE_HREF_RE = /^(?:https?:|mailto:|tg:)/i;

function sanitizeAttributes(tagName, attrsRaw) {
  // Only anchors (and <span class="tg-spoiler">) need attributes.
  if (tagName === 'a') {
    const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrsRaw || '');
    const href = hrefMatch ? (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '') : '';
    if (href && SAFE_HREF_RE.test(href)) {
      const safe = href.replace(/"/g, '&quot;');
      return ` href="${safe}" target="_blank" rel="noopener noreferrer"`;
    }
    return '';
  }
  if (tagName === 'span') {
    // Preserve only the tg-spoiler marker class; drop everything else.
    if (/\bclass\s*=\s*["'][^"']*\btg-spoiler\b[^"']*["']/i.test(attrsRaw || '')) {
      return ' class="tg-spoiler"';
    }
    return '';
  }
  if (tagName === 'blockquote') {
    if (/\bexpandable\b/i.test(attrsRaw || '')) return ' expandable';
    return '';
  }
  return '';
}

export function sanitizeTelegramHtmlForPreview(input) {
  const raw = String(input == null ? '' : input);

  // Tokenize by angle brackets. Anything not matching our allow-list is
  // dropped; text between tags is HTML-escaped for safety.
  const escapeText = (s) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const parts = raw.split(/(<[^>]*>)/g);
  let out = '';
  for (const part of parts) {
    if (!part) continue;
    if (part[0] === '<' && part[part.length - 1] === '>') {
      const inner = part.slice(1, -1);
      // Strip comments / doctypes / PIs entirely.
      if (inner.startsWith('!') || inner.startsWith('?')) continue;
      const isEnd = inner.startsWith('/');
      const body = isEnd ? inner.slice(1) : inner;
      const nameMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(body);
      // Not a valid tag name (e.g. "< 5 && 5 >" from literal text) —
      // escape it so the user sees their original characters.
      if (!nameMatch) { out += escapeText(part); continue; }
      const tagName = nameMatch[1].toLowerCase();
      // Tag name is valid but not on our Telegram allow-list: drop the
      // tag markup but keep any text after it rendered as text.
      if (!TELEGRAM_ALLOWED_TAGS.has(tagName)) continue;
      if (isEnd) {
        out += `</${tagName}>`;
      } else {
        const attrs = body.slice(nameMatch[0].length);
        // Self-closing <br/> normalization.
        const isSelfClose = tagName === 'br' || /\/$/.test(attrs.trim());
        out += `<${tagName}${sanitizeAttributes(tagName, attrs)}${isSelfClose ? '/' : ''}>`;
      }
    } else {
      out += escapeText(part);
    }
  }
  return out;
}
