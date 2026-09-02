/**
 * Trailer message parsing — façade.
 *
 * RE-EXPORT ONLY. The trailer monitor, the semantic verifier and several tests
 * import `services/trailerMessageParser`, so the path stays the stable public
 * seam while the rules live in focused modules. Everything below is PURE — no
 * database, no network, no AI — which is what lets the trailer monitor's
 * detection matrix be asserted directly:
 *
 *   ./trailerParser/vocabulary.js      the keyword/phrase/regex lists
 *   ./trailerParser/fieldExtractors.js unit number, location, condition, dates
 *   ./trailerParser/actionDetectors.js pickup vs drop-off, instruction vs done
 *   ./trailerParser/messageParser.js   one message → one structured result
 *   ./trailerParser/eventParser.js     multi-trailer message → one event each
 *
 * `normalizeUnitNumber` is re-exported from lib/trailers/normalize —
 * the single owner shared with the database layer. An independent copy here
 * would let parser matching drift away from master-list matching.
 */
const { normalizeUnitNumber } = require('../lib/trailers/normalize');
const {
  TRAILER_KEYWORDS, PICKUP_PHRASES, DROPOFF_PHRASES, CONDITION_KEYWORDS,
} = require('./trailerParser/vocabulary');
const {
  hasTrailerKeyword, extractUnitNumber, extractLocation, extractCondition, extractDate,
  extractReportedDriverName, extractAddressLine,
} = require('./trailerParser/fieldExtractors');
const {
  detectAction, detectMultilingualActionHint, detectInstructionPhrase, hasCompletionSignal,
  detectCargoSignal, resolveCargoPossession,
} = require('./trailerParser/actionDetectors');
const { parseTrailerMessage } = require('./trailerParser/messageParser');
const {
  parseTrailerMessageEvents, findUnitTokens, shouldUseAiFallback,
} = require('./trailerParser/eventParser');

module.exports = {
  parseTrailerMessage,
  parseTrailerMessageEvents,
  findUnitTokens,
  hasTrailerKeyword,
  extractUnitNumber,
  extractLocation,
  extractCondition,
  extractDate,
  extractReportedDriverName,
  detectAction,
  detectMultilingualActionHint,
  detectInstructionPhrase,
  hasCompletionSignal,
  extractAddressLine,
  detectCargoSignal,
  resolveCargoPossession,
  normalizeUnitNumber,
  shouldUseAiFallback,
  TRAILER_KEYWORDS,
  PICKUP_PHRASES,
  DROPOFF_PHRASES,
  CONDITION_KEYWORDS,
};
