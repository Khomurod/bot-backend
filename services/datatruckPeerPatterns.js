/**
 * Classify @datatruck_driver_bot peer messages for reactions / banter.
 *
 * The load-like matcher below used to live in services/loadTextPatterns.js,
 * shared with the pinned-load reading that the owner removed in October 2026
 * (docs/architecture/retired-dispatch-eta.md). This module was its last
 * reader, so it lives here now. Biased toward recall: a peer post that looks
 * like load content gets a reaction, and missing one costs more than noise.
 */

/**
 * One regex for "does this line look like load / dispatch content?"
 * Alternatives roughly ordered from specific tokens to broader numeric routes.
 */
const LOAD_LIKE_CHAT_MESSAGE_REGEX = new RegExp(
  '('
  + [
    String.raw`load\s*#`,
    String.raw`load\s+id\b`,
    String.raw`load\s*:\s*#?\s*[A-Za-z0-9]`,
    String.raw`load\s+(?:no\.?|number)\s*:?\s*[A-Za-z0-9]`,
    String.raw`load\s+\d{3,}\b`,
    String.raw`rate.?confirm|carrier_rate|secure.?rate.?con`,
    String.raw`\.pdf\b`,
    String.raw`live\s*[-/\\]\s*live`,
    String.raw`drop\s*[-/\\]?\s*hook|hook\s*[-/\\]?\s*drop`,
    String.raw`[A-Z]{2}\s*[-/>]+\s*[A-Z]{2}`,
    String.raw`\b(?:bol|pro\s*bill|bill\s*of\s*lading)\b`,
    String.raw`order\s*#\s*\d`,
    String.raw`\b(?:trip|shipment)\s*#\s*\d`,
  ].join('|')
  + ')',
  'i'
);

const DISPATCH_TEMPLATE_REGEX = /load\s*type\s*:|load\s*#\s*:|pu\s*#\s*:|^\s*rate\s*:/im;

const FAILURE_MESSAGE_REGEX = new RegExp(
  '('
  + [
    String.raw`unknown\s+command`,
    String.raw`not\s+a\s+valid\s+command`,
    String.raw`invalid\s+command`,
    String.raw`can'?t\s+complete`,
    String.raw`cannot\s+complete`,
    String.raw`unable\s+to\s+(?:complete|process|handle)`,
    String.raw`failed\s+to\s+(?:complete|process|handle)`,
    String.raw`error\s+processing`,
    String.raw`could\s+not\s+(?:complete|process|handle)`,
    String.raw`request\s+could\s+not\s+be\s+completed`,
  ].join('|')
  + ')',
  'i'
);

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase().replace(/^@/, '');
}

function isDatatruckPeerUser(from, expectedUsername) {
  if (!from || !from.is_bot) return false;
  const expected = normalizeUsername(expectedUsername);
  if (!expected) return false;
  return normalizeUsername(from.username) === expected;
}

function isDatatruckFailureMessage(text) {
  const source = String(text || '').trim();
  if (!source) return false;
  return FAILURE_MESSAGE_REGEX.test(source);
}

function isDatatruckLoadMessage(text) {
  const source = String(text || '').trim();
  if (!source) return false;
  if (/^\s*\//.test(source)) return false;
  if (LOAD_LIKE_CHAT_MESSAGE_REGEX.test(source)) return true;
  return DISPATCH_TEMPLATE_REGEX.test(source);
}

module.exports = {
  LOAD_LIKE_CHAT_MESSAGE_REGEX,
  FAILURE_MESSAGE_REGEX,
  DISPATCH_TEMPLATE_REGEX,
  normalizeUsername,
  isDatatruckPeerUser,
  isDatatruckFailureMessage,
  isDatatruckLoadMessage,
};
