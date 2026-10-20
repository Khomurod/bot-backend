'use strict';

/**
 * What can be read off a recruiter's post WITHOUT a model. Pure.
 *
 * Posts are free-form, but they follow a habit:
 *
 *   Company Driver - 80 CPM
 *   PHILLIPS SAMUEL JAHBARI
 *   3+ yrs of exp
 *   (704) 493-1180
 *
 * A NAME is a line of two to four words made only of letters, none of which
 * is a word a recruiter uses about the job ("company", "driver", "ready",
 * "exp" …). A line with a digit, an @ or a link is never a name. When no line
 * qualifies the caller asks a model for the name — and only the name.
 *
 * Names are shown as written, in title case: "PHILLIPS SAMUEL JAHBARI" →
 * "Phillips Samuel Jahbari". Which word is the surname is not guessed.
 */

const NOT_A_NAME = new Set(`
  company driver drivers team solo owner operator lease leased cpm exp experience year years yrs
  ready asap otr home regional local dedicated week weeks day days month months the and for with of
  he she his her him is are was will can could we us our please wanna want come back worked works
  new old cdl class hazmat tanker reefer dry van flatbed wenze unit safety mvr psp clh approved not
  test drug sap tomorrow today tonight monday tuesday wednesday thursday friday saturday sunday office
  truck trailer hire rehire main also planning arrive arriving coming info information need needs
  good morning hello hi thanks thank you done ok okay no yes per mile miles hour hours pay rate
  states state only all any team's ny nj ca tx fl ga
`.trim().split(/\s+/));

function titleCase(word) {
  return word
    .toLowerCase()
    .replace(/(^|[-'])([a-zà-ɏ])/g, (_m, sep, ch) => `${sep}${ch.toUpperCase()}`);
}

/** One line as a name, or null. */
function nameOfLine(line) {
  const text = String(line || '')
    .replace(/^[^\p{L}]+/u, '')
    .replace(/^(?:full\s+)?(?:name|driver)\s*[:\-–]\s*/i, '')
    .replace(/\((?:main|co-?driver|second|2nd|1st)\)/gi, '')
    .replace(/,/g, ' ')
    .trim();
  if (!text || /[\d@#]|https?:|www\./i.test(text)) return null;
  const words = text.split(/\s+/);
  if (words.length < 2 || words.length > 4) return null;
  if (!words.every((w) => /^\p{L}[\p{L}'.-]*$/u.test(w))) return null;
  if (words.some((w) => NOT_A_NAME.has(w.toLowerCase().replace(/[.']+$/, '')))) return null;
  return words.map(titleCase).join(' ');
}

/** The names written in a post, in order, each once. */
function namesInPost(text) {
  const seen = new Set();
  const names = [];
  for (const line of String(text || '').split(/\n+/)) {
    const name = nameOfLine(line);
    const key = name?.toLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      names.push(name);
    }
  }
  return names;
}

/** A Telegram name without the job title people put after a bar: "Amelia Carter | Driver Relations" → "Amelia Carter". */
function personName(fromName) {
  const name = String(fromName || '').split('|')[0].trim();
  return name || null;
}

module.exports = { namesInPost, nameOfLine, personName };
