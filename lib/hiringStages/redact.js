'use strict';

/**
 * What of the recruiting conversation may leave for a model, and the phone
 * numbers a deal is looked up by. Pure.
 *
 * THE GROUP CARRIES MORE THAN NAMES. A recruiter asking for a drug test pastes
 * "ssn; 455453402" and an address under the driver's name, in the same thread
 * the model is shown. None of that helps anyone read a stage, so it never
 * leaves: an SSN (labelled, or in its 3-2-4 shape), a labelled birth date or
 * licence number, every phone number, and every other long run of digits is
 * replaced with a marker BEFORE the text is put in a prompt. The marker says
 * what was there, so the model still reads "ssn: [removed]" as a request for a
 * drug test rather than as nothing.
 *
 * Names stay: the deal is matched by name when the phone finds nothing, and a
 * person checks the name on the proposal before pressing the button.
 */

const LABELLED = [
  // "ssn; 455453402", "SSN: 455-45-3402", "social security number 455 45 3402"
  [/\b(ssn|social\s+security(?:\s+(?:number|no\.?|#))?)\b(\s*[:;#=\-.]?\s*)[\d][\d\s\-]{7,12}\d/gi, '$1$2[removed]'],
  // "dob: 01/02/1980", "date of birth 1980-01-02"
  [/\b(dob|d\.o\.b\.?|date\s+of\s+birth|birth\s*date)\b(\s*[:;#=\-.]?\s*)[\d][\d/.\-\s]{4,12}\d/gi, '$1$2[removed]'],
  // "CDL # A1234567", "license number: D123-456-789"
  [/\b(cdl|license|licence|dl)(\s*(?:#|no\.?|number|num)\s*[:;]?\s*)[A-Z0-9][A-Z0-9\-]{4,}/gi, '$1$2[removed]'],
];

const SSN_SHAPE = /\b\d{3}-\d{2}-\d{4}\b/g;

/**
 * North-American numbers as people type them: "+1 (404) 555-0134",
 * "404.555.0134", "4045550134", "1-404-555-0134". Exactly ten digits after an
 * optional country code, so a nine-digit SSN never reads as a phone.
 */
const PHONE = /(?<![\d])(?:\+?1[\s.\-]?)?\(?([2-9]\d{2})\)?[\s.\-]?(\d{3})[\s.\-]?(\d{4})(?![\d])/g;

const LONG_DIGITS = /\d[\d\s\-]{5,}\d/g;

function stripLabelled(text) {
  let out = String(text || '');
  for (const [pattern, replacement] of LABELLED) out = out.replace(pattern, replacement);
  return out.replace(SSN_SHAPE, '[removed]');
}

/** The text with identifying numbers taken out (see the header). */
function redactForAi(text) {
  return stripLabelled(text)
    .replace(PHONE, '[phone]')
    .replace(LONG_DIGITS, (run) => (run.replace(/\D/g, '').length >= 7 ? '[number]' : run));
}

/**
 * The ten-digit phone numbers written in a text, in order, unique. An SSN is
 * taken out first, so "ssn 455453402" plus a stray digit never becomes a phone.
 */
function extractPhones(text) {
  const seen = new Set();
  for (const m of stripLabelled(text).matchAll(PHONE)) seen.add(`${m[1]}${m[2]}${m[3]}`);
  return [...seen];
}

module.exports = { redactForAi, extractPhones };
