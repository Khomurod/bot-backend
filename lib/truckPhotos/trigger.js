'use strict';

/**
 * Is this message somebody marking a truck hand-over or return? Pure.
 *
 * The owner's words (6 November 2026): `outbound` when the truck is handed
 * over, `inbound` when it comes back. Whole words only, any letter case —
 * "Outbound", "#INBOUND", "outbound truck ✅" — never inside another word
 * ("outbounds", "inboundcall").
 *
 * BARE OR NOT is the question the rest of the feature turns on. A message that
 * is only the word — give or take "truck", a "#", emoji and punctuation —
 * means nothing else, so no model is asked about it. Anything more ("outbound
 * load from Chicago", "inbound 562", a sentence) could be about something
 * other than the truck, and a model is asked; with no model, it is NOT made
 * into a PDF (services/truckPhotos/aiCheck.js).
 *
 * BOTH WORDS IN ONE MESSAGE ("inbound/outbound inspection") is not a trigger:
 * there is no way to say which PDF it asks for.
 */

const WORD = /(?<![\p{L}\p{N}_])(outbound|inbound)(?![\p{L}\p{N}_])/giu;
/** Words that may stand beside the trigger without making it "not bare". */
const FILLER = /(?<![\p{L}\p{N}_])trucks?(?![\p{L}\p{N}_])/giu;
/** Emoji, their joiners and modifiers, punctuation, symbols, "#", whitespace. */
const DECORATION = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}‍︎️⃣\p{P}\p{S}\s]/gu;

/**
 * @param {*} text  a message's text or caption
 * @returns {{kind: 'outbound'|'inbound', bare: boolean}|null}
 */
function readTrigger(text) {
  const source = typeof text === 'string' ? text : '';
  if (!source.trim()) return null;
  const kinds = new Set([...source.matchAll(WORD)].map((m) => m[1].toLowerCase()));
  if (kinds.size !== 1) return null;
  const [kind] = kinds;
  const rest = source.replace(WORD, ' ').replace(FILLER, ' ').replace(DECORATION, '');
  return { kind, bare: rest.length === 0 };
}

module.exports = { readTrigger };
