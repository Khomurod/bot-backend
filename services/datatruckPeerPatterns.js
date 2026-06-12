/**
 * Classify @datatruck_driver_bot peer messages for reactions / banter.
 */
const { isLoadLikeChatMessage } = require('./loadTextPatterns');

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
  if (isLoadLikeChatMessage(source)) return true;
  return DISPATCH_TEMPLATE_REGEX.test(source);
}

module.exports = {
  FAILURE_MESSAGE_REGEX,
  DISPATCH_TEMPLATE_REGEX,
  normalizeUsername,
  isDatatruckPeerUser,
  isDatatruckFailureMessage,
  isDatatruckLoadMessage,
};
