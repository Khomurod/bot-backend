'use strict';

/**
 * Could this driver message be about leaving the company? PURE.
 *
 * THE GATE IN FRONT OF THE MODEL. The owner's decision, October 2026: the AI
 * must not read every driver message. Of what the annotator used to label —
 * sixteen intents, sentiment, tone — the one thing still wanted is a driver
 * saying they are leaving (`quit_signal`), the heaviest retention signal and
 * the notice the retention chat exists for. Home-time requests and
 * "Status: Home / on the road" are read by their own deterministic paths and
 * never needed this one.
 *
 * So a message reaches the model only when it carries a cue below. Everything
 * else is recorded as `no_signal` without a call — 91 model calls a day became
 * a handful, on a free tier that ran out daily.
 *
 * RECALL OVER PRECISION, deliberately. A cue only buys a model call; the model
 * still decides whether the driver is actually leaving. A missed cue is a
 * driver nobody rings, so the lists err wide: "last load" and "another
 * company" pass even though most of them mean nothing.
 *
 * English, Russian, and Uzbek in both Latin and Cyrillic script — the three
 * languages the driver groups write in. Matching is on lower-cased text with
 * the apostrophe variants Uzbek Latin uses folded to one.
 */

const CUES = Object.freeze([
  // ── English ──────────────────────────────────────────────────────────────
  /\bquit(s|ting)?\b/,
  /\bresign(ing|ed|ation)?\b/,
  /\bleav(e|ing)\b.{0,20}\b(company|wenze|job|you guys|this place)\b/,
  /\b(two|2)[ -]?weeks?'?s? notice\b/,
  /\b(my|put in|give|giving|gave) (my |a )?notice\b/,
  /\blast (load|trip|week|day|run)\b/,
  /\b(another|other|new|different) (company|job|carrier)\b/,
  /\b(find|found|finding|looking for) (a )?(new|another|other|different) (job|company|carrier)\b/,
  /\b(turn(ing)? in|drop(ping)? off|return(ing)?|bring(ing)? back) (the |my )?(truck|trailer|keys)\b/,
  /\bdone (with|working for) (this|the|your) (company|job)\b/,
  /\bterminat(e|ed|ion)\b/,
  // ── Russian ──────────────────────────────────────────────────────────────
  /уход|ухожу|уйду|уйти/,
  /увол[ьи]/,
  /(друг|нов)(ую|ой|ая) (компани|работ)/,
  /последн(ий|яя|юю|ее) (рейс|груз|недел|день)/,
  /сда(ю|м|ть|вать) (трак|машин|ключ|трейлер)/,
  /рассчит|расч[её]т/,
  // ── Uzbek, Latin script ──────────────────────────────────────────────────
  /\bket(aman|yapman|moqchi|dim|ish)/,
  /\bishdan\b/,
  /\bboshqa (kompaniya|kampaniya|ish)/,
  /\boxirgi (reys|yuk|hafta|kun)/,
  /\bbo'?sha(yman|tish|dim)/,
  // ── Uzbek, Cyrillic script ───────────────────────────────────────────────
  /кет(аман|япман|моқчи|дим)/,
  /ишдан/,
  /бошқа (компания|кампания|иш)/,
  /охирги (рейс|юк|ҳафта|кун)/,
  /бўша(йман|тиш|дим)/,
]);

/** Lower-case, and fold the apostrophes Uzbek Latin is typed with. */
function normalise(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’ʻʼ`]/g, "'");
}

/**
 * @param {string} text a driver's message
 * @returns {boolean} true when the message is worth a model's reading
 */
function mentionsLeaving(text) {
  const t = normalise(text);
  if (!t.trim()) return false;
  return CUES.some((re) => re.test(t));
}

/** What a message the model was never shown is recorded as. */
const KEYWORD_SKIP_VERSION = 'keyword-prefilter-v1';

/**
 * The row for a message with no cue: `no_signal`, and nothing else claimed.
 * Sentiment, role and language stay NULL — "not read" must never look like
 * "read and found neutral", which is the distinction retention's averages
 * already depend on.
 */
function unreadAnnotation(id) {
  return {
    id,
    language: null,
    intent: 'no_signal',
    sentiment: null,
    urgency: null,
    role: null,
    role_confidence: null,
    is_acknowledgement: false,
    toxic: false,
    entities: null,
  };
}

/** Split recorded messages into those worth a model call and the rest. */
function splitByLeavingCue(logs) {
  const toRead = [];
  const skipped = [];
  for (const log of logs || []) {
    if (mentionsLeaving(log?.message_text)) toRead.push(log);
    else skipped.push(log);
  }
  return { toRead, skipped };
}

module.exports = {
  CUES, KEYWORD_SKIP_VERSION, mentionsLeaving, unreadAnnotation, splitByLeavingCue,
};
