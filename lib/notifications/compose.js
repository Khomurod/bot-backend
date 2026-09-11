/**
 * Writing an operational notice. PURE — text in, text out, no I/O.
 *
 * These go to a staff chat that an operator reads on a phone, often at speed,
 * often at 3am. So the shape is fixed and short: a heading that says what
 * happened, at most a few short lines of the facts that matter, and — only when
 * a person has to do something — one line saying what.
 *
 * Two rules the composer enforces rather than trusting a caller to remember:
 *
 *   NO LONG AI EXPLANATIONS. A model's reasoning is recorded in the audit trail
 *   where it can be read at leisure; in a chat it is noise that buries the fact.
 *   Any reason is clipped hard, and it is clipped HERE so no caller can opt out.
 *
 *   NO CREDENTIALS, NO SIGNED URLS. A notice is delivered to a group chat and
 *   kept in its history forever. `sanitise` drops anything shaped like a key or
 *   a signed media link rather than trusting each caller to have thought about
 *   it.
 */

/** Longest a single supporting line may be before it is cut. */
const MAX_LINE = 160;
/** Longest an explanation may be. Two sentences, not a paragraph. */
const MAX_REASON = 220;
/** Telegram's own limit is 4096; staying well under it keeps a notice readable. */
const MAX_BODY = 1200;

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>]/g, (c) => ESCAPES[c]);
}

/**
 * Remove anything that must never be posted into a chat's permanent history.
 *
 * Deliberately blunt: a long opaque token, an `Authorization:` header echoed
 * out of an error body, a query string carrying a signature or an expiry. A
 * false positive costs a few redacted characters in a status line; a false
 * negative puts a live credential in a group chat.
 */
function sanitise(text) {
  return String(text ?? '')
    // A signed or expiring URL — Samsara media links look like this.
    .replace(/https?:\/\/\S*?[?&](?:sig|signature|token|expires|x-amz-signature)=\S*/gi, '[link removed]')
    // An echoed auth header. The scheme word is part of what gets consumed:
    // matching `authorization:` and stopping at `Bearer` redacted the SCHEME
    // and published the key that followed it.
    .replace(
      /\b(authorization|api[-_]?key|x-api-key|access[-_]?token|secret)\b\s*[:=]\s*(?:bearer|token|basic)?\s*\S+/gi,
      '$1: [redacted]'
    )
    // A bearer token with no header name in front of it.
    .replace(/\bbearer\s+\S+/gi, 'bearer [redacted]')
    // A bare long token: 24+ characters of key-ish alphabet with no spaces.
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]');
}

function clip(text, max) {
  const s = sanitise(text).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Build the message body.
 *
 * @param {object} notice
 * @param {string} notice.icon      one emoji, the category's own
 * @param {string} notice.title     what happened, in a few words
 * @param {string[]} [notice.lines] the facts, one per line
 * @param {string} [notice.reason]  why, clipped hard
 * @param {string} [notice.action]  the one thing a person should do, if any
 * @returns {string} HTML-safe Telegram body
 */
function composeNotice({ icon = 'ℹ️', title, lines = [], reason = null, action = null } = {}) {
  // BUILT PLAIN, TRUNCATED PLAIN, THEN ESCAPED AND MARKED UP.
  //
  // Slicing a string that already contains `&amp;` and `<b>` can cut through an
  // entity or a tag. Telegram then rejects the whole message as malformed HTML
  // — on every retry, until the notice is abandoned — and the more ampersands a
  // driver's name or an error body contains, the likelier it is. So the length
  // budget is spent on the TEXT, and the markup is added afterwards where it
  // can never be cut.
  const parts = [];
  const title_ = clip(title, MAX_LINE);
  parts.push({ kind: 'title', text: title_ });
  for (const line of lines) {
    const text = clip(line, MAX_LINE);
    if (text) parts.push({ kind: 'line', text });
  }
  if (reason) {
    const text = clip(reason, MAX_REASON);
    if (text) parts.push({ kind: 'reason', text });
  }
  if (action) {
    const text = clip(action, MAX_LINE);
    if (text) parts.push({ kind: 'action', text });
  }

  // Drop whole parts until the plain text fits. A notice that loses its last
  // supporting line is readable; one that loses half an HTML entity is not
  // delivered at all. The title and the action are the two a reader needs, so
  // the middle goes first.
  // The budget is measured on the ESCAPED text plus its markup, because that is
  // what Telegram receives. Counting the plain text instead understates it
  // badly: one `&` in a driver's name becomes five characters, so a body of
  // ampersands sails past a plain-text limit and arrives at twice the size.
  const renderedLength = (part) => escapeHtml(part.text).length + 12;
  const budget = () => parts.reduce((n, part) => n + renderedLength(part), 0);
  while (budget() > MAX_BODY && parts.length > 1) {
    const droppable = parts.findIndex((p) => p.kind === 'line' || p.kind === 'reason');
    parts.splice(droppable === -1 ? parts.length - 1 : droppable, 1);
  }
  // One part still over budget: cut the PLAIN text, a character at a time, until
  // its escaped form fits. Cutting the escaped form is what splits an entity.
  while (parts.length && budget() > MAX_BODY && parts[0].text.length > 1) {
    const keep = Math.max(1, Math.floor(parts[0].text.length * 0.8));
    parts[0].text = `${parts[0].text.slice(0, keep)}…`;
  }

  return parts.map((p) => {
    const safe = escapeHtml(p.text);
    if (p.kind === 'title') return `${icon} <b>${safe}</b>`;
    if (p.kind === 'reason') return `<i>${safe}</i>`;
    if (p.kind === 'action') return `→ ${safe}`;
    return safe;
  }).join('\n');
}

/**
 * The idempotency key for a notice.
 *
 * Background checks re-derive the same condition every few minutes and the
 * process restarts several times a day, so "have I already said this?" cannot
 * live in memory. It lives in a UNIQUE column, and this builds its value:
 * category, subject, and a caller-chosen discriminator that changes when the
 * EVENT changes but not when the same event is merely seen again.
 */
function noticeKeyFor(category, subjectType, subjectId, discriminator = null) {
  const parts = [category, subjectType, String(subjectId ?? '')];
  if (discriminator) parts.push(String(discriminator));
  return parts.join(':');
}

module.exports = {
  MAX_LINE,
  MAX_REASON,
  MAX_BODY,
  escapeHtml,
  sanitise,
  clip,
  composeNotice,
  noticeKeyFor,
};
