'use strict';

/**
 * "Was this code voided, or is somebody asking about it?" PURE.
 *
 * THE DISTINCTION THIS FILE EXISTS FOR. In a real finance chat these arrive
 * minutes apart and mean opposite things:
 *
 *     "need to void this one?"     — a question. Nothing has happened.
 *     "please void 1491583146"     — a request. Nothing has happened YET.
 *     "working on it"              — still nothing.
 *     "voided"                     — now something has happened.
 *
 * Treating the first three as a void marks live money dead; treating the last
 * as chatter leaves spent money on the books. So the classification is
 * deliberately conservative in ONE direction: anything that is not plainly a
 * completed action is not a completed action. A request is recorded as a
 * request — it is useful context, and it is not a void.
 *
 * WHY NOT JUST LOOK FOR THE WORD "VOID". Because "should we void this" contains
 * it, and so does "do not void that one". The word says the subject; the
 * grammar around it says whether it happened — and that half lives in
 * `../phrasing.js`, shared with replacement detection, because it is the same
 * judgement about a different verb.
 */

const { scanCodes } = require('../moneycode/values');
const { classifyModality, MODALITY } = require('../phrasing');

const VOID_KIND = Object.freeze({
  COMPLETED: 'completed',
  REQUEST: 'request',
  NONE: 'none',
});

/** The subject words. Without one of these, none of the rest is consulted. */
const VOID_WORDS = /\b(void(?:ed|ing|s)?|cancel(?:led|ed|ling|ing|s)?|kill(?:ed)?|revok(?:e|ed)|stop(?:ped)?\s+(?:the\s+)?(?:code|check))\b/i;

/**
 * What is this message doing about a void?
 *
 * @returns `{ kind, codes, phrase, reason }` — `codes` are the code-shaped
 *   digit runs the message itself named, copied verbatim. An empty list means
 *   the target has to come from the conversation (see `target.js`), never from
 *   an assumption made here.
 */
function classifyVoidLanguage(text) {
  const source = String(text || '');
  const none = { kind: VOID_KIND.NONE, codes: [], phrase: null, reason: null };
  if (!VOID_WORDS.test(source)) return none;

  const codes = scanCodes(source);
  const phrase = (source.match(VOID_WORDS) || [])[0] || null;
  const { modality, reason } = classifyModality(source);

  switch (modality) {
    case MODALITY.NEGATED:
      return { kind: VOID_KIND.NONE, codes, phrase, reason: 'the void is negated' };
    case MODALITY.QUESTION:
    case MODALITY.IN_PROGRESS:
    case MODALITY.REQUEST:
      return { kind: VOID_KIND.REQUEST, codes, phrase, reason };
    case MODALITY.COMPLETED:
      return { kind: VOID_KIND.COMPLETED, codes, phrase, reason };
    default:
      // "void this" — an imperative. Somebody is asking, not reporting.
      return {
        kind: VOID_KIND.REQUEST, codes, phrase,
        reason: 'an instruction, not a report that it is done',
      };
  }
}

module.exports = { VOID_KIND, VOID_WORDS, classifyVoidLanguage };
