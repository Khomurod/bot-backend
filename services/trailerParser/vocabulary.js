/**
 * Trailer message VOCABULARY — the words and patterns the parser recognizes.
 *
 * Drivers write in several languages and in shorthand, so every keyword list,
 * phrase set and regex the parser matches on lives here in one place. Changing
 * a list changes what the trailer monitor detects, which is why they are
 * separated from the extraction logic that consumes them.
 *
 * Split out of services/trailerMessageParser.js, which re-exports the public
 * surface so existing importers are unchanged.
 */

/**
 * Trailer message parser — deterministic first pass.
 *
 * Reads a driver-group message (text OR photo caption) and, WITHOUT any AI,
 * classifies it and extracts the structured fields we can find with confidence.
 * The AI classifier (services/trailerClassifier.js) is only a fallback/enrichment
 * layer for messy input; this file handles the obvious, well-formed cases so the
 * common path never depends on a network call.
 *
 * Classification categories:
 *   - pickup     : a trailer unit + a clear "picked up" action
 *   - dropoff    : a trailer unit + a clear "dropped / dropped off" action
 *   - mention_only : a trailer keyword but no clear pickup/dropoff action
 *   - unidentified : looks trailer-related but too little to act on
 *
 * IMPORTANT: this parser never INVENTS a unit number, location, or condition.
 * When a field is not present in the text, it is left null and (for actions
 * with no unit) the message is treated as unidentified.
 */

// ── keyword vocabularies ──
// Presence of any of these means the message is at least "about trailers".
const TRAILER_KEYWORDS = [
  'trailer', 'trailers', 'trl', 'trailer #', 'trailer unit',
];

// "unit" alone is ambiguous (drivers also say "unit" for trucks), so it only
// counts as a trailer signal when paired with a trailer word or a unit token.
const PICKUP_PHRASES = [
  'picked up back', 'picked up', 'pick up', 'pickup', 'grabbed trailer',
  'grabbed the trailer', 'hooked trailer', 'hooked up', 'hooked to',
  'swapped trailer', 'swapped to', 'got the trailer', 'took the trailer',
  'took trailer', 'hooked the trailer', 'grabbed', 'hooked',
];

const DROPOFF_PHRASES = [
  'dropped off', 'drop off', 'dropped by', 'dropped', 'drop', 'left trailer',
  'left the trailer', 'trailer dropped', 'dropped the trailer', 'droped', // common typo
  'droped off', 'droping',
];

// ── multilingual action hints (Uzbek Latin/Cyrillic, Russian) ──
// Used ONLY by the cheap candidate filter to decide that a message MIGHT be a
// trailer action worth sending to semantic AI verification. These hints never
// authorize a state change by themselves — completed-vs-planned is the semantic
// verifier's job. Word-boundary-ish regexes tolerant of suffixes.
const MULTILINGUAL_PICKUP_HINTS = [
  // Uzbek Latin: oldim (I took), olib oldim, olaman (I will take), olasiz (you
  // will take), olamiz, oladi, olib boraman/borasiz, ildim (hooked)
  /\bol(?:dim|dik|di|aman|asiz|amiz|adi|ib)\b/i, /\bolib\s+ol/i, /\bil(?:dim|di)\b/i,
  // Uzbek Cyrillic + Russian. NOTE: \b is ASCII-only in JS, so Cyrillic words
  // use explicit letter lookarounds instead.
  /(?<![а-яё])(?:олдим|оламан|оласиз|олади|олиб)(?![а-яё])/i,
  // Russian: забрал(а), заберу, забери, забрать, взял, возьму, возьмёшь,
  // подцепил, прицепил, зацепил
  /(?<![а-яё])забрал[аи]?(?![а-яё])/i, /(?<![а-яё])забер[уиёе][а-яё]*(?![а-яё])/i,
  /(?<![а-яё])забрать(?![а-яё])/i, /(?<![а-яё])вз[яе]л[аи]?(?![а-яё])/i,
  /(?<![а-яё])возьм[уёе][а-яё]*(?![а-яё])/i, /(?<![а-яё])(?:под|при|за)цепил[аи]?(?![а-яё])/i,
];

const MULTILINGUAL_DROPOFF_HINTS = [
  // Uzbek Latin: tashladim (I dropped), tashlayman, tashlaysiz, tashlab,
  // qoldirdim (I left), qoldiraman, qo'ydim (I put/left)
  /\btashla(?:dim|dik|di|yman|ysiz|b)\b/i, /\bqoldir(?:dim|dik|di|aman|asiz)\b/i, /\bqo['’`ʻ]?ydim\b/i,
  // Uzbek Cyrillic
  /(?<![а-яё])(?:ташладим|ташлайман|қолдирдим|колдирдим)(?![а-яёқ])/i,
  // Russian: сбросил, скинул, бросил, оставил, оставлю, отцепил, брошу
  /(?<![а-яё])с?брос[иы]л[аи]?(?![а-яё])/i, /(?<![а-яё])скинул[аи]?(?![а-яё])/i,
  /(?<![а-яё])остав(?:ил[аи]?|лю|ь)(?![а-яё])/i, /(?<![а-яё])отцепил[аи]?(?![а-яё])/i,
  /(?<![а-яё])брошу(?![а-яё])/i, /(?<![а-яё])скину(?![а-яё])/i,
];

const CONDITION_KEYWORDS = [
  'no pictures', 'no photos', 'with pictures', 'with photos', 'damage',
  'damaged', 'flat tire', 'flat', 'lights issue', 'light issue', 'lights',
  'good condition', 'bad condition', 'empty', 'loaded', 'clean', 'dirty',
  'condition',
];

// ── cargo vocabularies ──
// Word-boundary regexes so "no load" does not match inside "unloaded", "mt" does
// not match inside "empty", etc. Order does not matter — detectCargoStatus runs
// both and resolves conflicts explicitly (both present → ambiguous → unknown).
// NOTE: a standalone "full" is NOT cargo evidence — drivers write "no full
// pictures", "full set of photos", "full inspection". Only cargo-specific
// phrasings ("full trailer", "trailer is full") count as loaded.
const LOADED_PATTERNS = [
  /\bloaded\b/, /\bwith\s+load\b/, /\bunder\s+load\b/, /\bsealed\b/,
  /\bwith\s+a\s+load\b/, /\bdrop(?:ped)?\s+loaded\b/,
  /\bfull\s+trailer\b/, /\btrailer\s+(?:is\s+)?full\b/,
];

const EMPTY_PATTERNS = [
  /\bempty\b/, /\bmt\b/, /\bno\s+load\b/, /\bunloaded\b/, /\bno\s+cargo\b/,
];

// ── instruction / assignment phrasing (NOT a completed action) ──
// A message that ASSIGNS a pickup/drop-off location or COMMANDS one ("Trailer
// drop-off address: …", "drop this trailer at …", "pickup address: …") must
// never register a completed event. English patterns only here — the semantic
// AI handles the long multilingual tail; this deterministic guard just keeps the
// obvious label/imperative cases out of the completed-action path (and out of
// the legacy no-AI path). NOTE: order-independent, checked only when NO
// completion signal is present.
const DROPOFF_INSTRUCTION_PATTERNS = [
  /\bdrop[\s-]?off\s+address\b/i,
  /\bdrop[\s-]?off\s+location\b/i,
  /\bdrop[\s-]?off\s+point\b/i,
  /\baddress\s+(?:for|to)\s+(?:the\s+)?drop/i,
  /\bdrop\s+(?:this|the|it|your)?\s*trailer\s+(?:at|to|here|off\s+at)\b/i,
  /\b(?:take|bring|leave)\s+(?:this|the|your)?\s*trailer\s+(?:to|at|here)\b/i,
  /\bwhere\s+(?:to|you\s+(?:need\s+to\s+)?)\s*drop\b/i,
];

const PICKUP_INSTRUCTION_PATTERNS = [
  /\bpick[\s-]?up\s+address\b/i,
  /\bpick[\s-]?up\s+location\b/i,
  /\bpick[\s-]?up\s+point\b/i,
  /\baddress\s+(?:for|to)\s+(?:the\s+)?pick/i,
  /\bpick\s+(?:it|this|the)?\s*up\s+(?:from|at)\b/i,
];

// Clear English completion evidence — its presence means the message is NOT a
// mere instruction (a real "dropped/picked up/left it" report).
const COMPLETION_SIGNAL_RE =
  /\b(?:dropped|droped|picked\s+up|left\s+(?:it|the\s+trailer|trailer\s+there|them)|hooked\s+up|hooked\s+to|grabbed\s+(?:the\s+)?trailer|drop\s+completed|already\s+(?:dropped|delivered|picked))\b/i;

/** Lowercased, whitespace-collapsed copy for keyword scanning. */
function norm(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

module.exports = {
  TRAILER_KEYWORDS,
  PICKUP_PHRASES,
  DROPOFF_PHRASES,
  MULTILINGUAL_PICKUP_HINTS,
  MULTILINGUAL_DROPOFF_HINTS,
  CONDITION_KEYWORDS,
  LOADED_PATTERNS,
  EMPTY_PATTERNS,
  DROPOFF_INSTRUCTION_PATTERNS,
  PICKUP_INSTRUCTION_PATTERNS,
  COMPLETION_SIGNAL_RE,
  norm,
};
