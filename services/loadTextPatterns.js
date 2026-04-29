/**
 * Load-related text detection for driver chat + ingestion fallback.
 * Biased toward recall: missing a real dispatch message hurts more than rare noise.
 */

'use strict';

/** Min digits for "Load 418911" style (no #). Avoids "Load 50 miles" style noise. */
const BARE_LOAD_NUMBER_MIN_DIGITS = 3;

/**
 * One regex for “does this line look like load / dispatch content?”
 * Keep alternatives roughly ordered from specific tokens to broader numeric routes.
 */
const LOAD_LIKE_CHAT_MESSAGE_REGEX = new RegExp(
  '(' +
    [
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
    ].join('|') +
    ')',
  'i'
);

function isLoadLikeChatMessage(text) {
  const source = String(text || '');
  if (!source.trim()) return false;
  if (/^\s*\/(?:location|update|status)\b/i.test(source)) return false;
  return LOAD_LIKE_CHAT_MESSAGE_REGEX.test(source);
}

/**
 * Best-effort primary load id / number from caption or transcript (storage + UI).
 * Tries explicit markers first, then bare “Load 418911”.
 */
function extractLoadIdentifier(text) {
  const s = String(text || '');
  const ordered = [
    /\bload\s*#\s*([A-Za-z0-9\-]+)/i,
    /\bload\s*:\s*#?\s*([A-Za-z0-9\-]+)/i,
    /\bload\s+id\s*:?\s*([A-Za-z0-9\-]+)/i,
    /\bload\s+(?:no\.?|number)\s*:?\s*([A-Za-z0-9\-]+)/i,
    /\b(?:order|trip|shipment)\s*#\s*([A-Za-z0-9\-]+)/i,
    new RegExp(String.raw`\bload\s+(\d{${BARE_LOAD_NUMBER_MIN_DIGITS},})\b`, 'i'),
  ];
  for (const re of ordered) {
    const m = s.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

module.exports = {
  BARE_LOAD_NUMBER_MIN_DIGITS,
  LOAD_LIKE_CHAT_MESSAGE_REGEX,
  extractLoadIdentifier,
  isLoadLikeChatMessage,
};
