'use strict';

/**
 * The NAME the bot writes to Bitrix for a candidate it creates — the deal's
 * TITLE and the contact's NAME / LAST_NAME. Pure.
 *
 * WHY (owner, 13–14 November 2026). Deals were titled from the recruiter's
 * post line exactly as written: surname first ("Goowin Leah Ann"), with the
 * recruiter's typos, while Safety had written "LEAH GOODWIN APPROVED" under
 * the same post. Safety reads the CDL; the recruiter types from memory.
 *
 * THE RULE. Safety's own messages in the conversation (the people named as
 * Safety in Settings — read by RULES from what they typed, NEVER from a
 * model's output) are searched for a RUN of consecutive words that are the
 * post's name words. A word matches a post word when it is the same ignoring
 * case, or — both at least five letters — one letter edit away
 * (lib/drivers/nameTolerance.js `oneEditApart`). A run counts only with TWO
 * or more matched words; the longest run wins (a later message on a tie).
 *
 *   spelling  where post and Safety spell a word differently, SAFETY's
 *             spelling (owner decision f).
 *   order     Safety's run covers every post word → Safety's order.
 *             Safety's run ends with the post's FIRST word → the post was
 *             written surname first, as on a CDL ("LAST FIRST MIDDLE"):
 *             "FIRST MIDDLE … LAST".
 *             Anything else → the post's order. Which word is a surname is
 *             never guessed beyond that.
 *
 * No Safety run → the post's name exactly as today. Words are title-cased
 * like the post's (lib/safetyApprovals/postDetails.js), a suffix ("Jr",
 * "III") stays last. The words a contact or deal is FOUND by stay the post's
 * (lib/hiringStages/identity.js `name`); this is only what is written.
 */

const { titleCase } = require('../safetyApprovals/postDetails');
const { oneEditApart } = require('../drivers/nameTolerance');

const SUFFIX = /^(?:jr|sr|ii|iii|iv)\.?$/i;
const MIN_MATCHED = 2;
const MIN_FUZZY_LETTERS = 5;

function suffixCase(word) {
  return /^(?:ii|iii|iv)\.?$/i.test(word) ? word.toUpperCase() : word;
}

const letters = (word) => word.replace(/[^\p{L}]/gu, '').length;

/** Does the Safety word `said` name the post word `posted`? */
function wordsMatch(said, posted) {
  const a = said.toLowerCase();
  const b = posted.toLowerCase();
  if (a === b) return true;
  return letters(a) >= MIN_FUZZY_LETTERS && letters(b) >= MIN_FUZZY_LETTERS && oneEditApart(a, b);
}

/** A message's words, in order; anything that is not a word (a number, a link) is `null` and breaks a run. */
function tokensOf(text) {
  return String(text || '').split(/\s+/).filter(Boolean).map((raw) => {
    const word = raw.replace(/’/g, "'").replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    return /^\p{L}[\p{L}'-]*$/u.test(word) ? word : null;
  });
}

/** The post word index this token names — an exact match first — among those not yet used. */
function matchIndex(token, plain, used) {
  const free = plain.map((w, i) => i).filter((i) => !used.has(i));
  const exact = free.find((i) => token.toLowerCase() === plain[i].toLowerCase());
  if (exact !== undefined) return exact;
  const close = free.find((i) => wordsMatch(token, plain[i]));
  return close === undefined ? -1 : close;
}

/** The longest run of post words in one message: [{index, spelled}] in Safety's order. */
function longestRun(text, plain) {
  const tokens = tokensOf(text);
  let best = [];
  for (let start = 0; start < tokens.length; start += 1) {
    const used = new Set();
    const run = [];
    for (let j = start; j < tokens.length && tokens[j]; j += 1) {
      const index = matchIndex(tokens[j], plain, used);
      if (index < 0) break;
      used.add(index);
      run.push({ index, spelled: tokens[j] });
    }
    if (run.length > best.length) best = run;
  }
  return best;
}

/**
 * @param {object} args
 * @param {string} args.postName          the post's one driver name (read by rules)
 * @param {string[]} [args.safetyTexts]   what Safety's people typed in this conversation, oldest first
 * @returns {{name: string, source: 'post'|'safety', order: 'post'|'safety'|'surname_last'}}
 */
function displayName({ postName, safetyTexts = [] }) {
  const name = String(postName || '').replace(/\s+/g, ' ').trim();
  const words = name.split(' ').filter(Boolean);
  const plain = words.filter((w) => !SUFFIX.test(w));
  const suffixes = words.filter((w) => SUFFIX.test(w)).map((w) => suffixCase(titleCase(w)));
  const unchanged = { name, source: 'post', order: 'post' };
  if (plain.length < MIN_MATCHED) return unchanged;

  let run = [];
  for (const text of safetyTexts) {
    const found = longestRun(text, plain);
    if (found.length >= MIN_MATCHED && found.length >= run.length) run = found;
  }
  if (run.length < MIN_MATCHED) return unchanged;

  const spelled = plain.map((w) => titleCase(w));
  for (const { index, spelled: word } of run) spelled[index] = titleCase(word);

  let order = plain.map((w, i) => i);
  let how = 'post';
  if (run.length === plain.length) {
    order = run.map((r) => r.index);
    how = 'safety';
  } else if (run.at(-1).index === 0) {
    order = [...order.slice(1), 0];
    how = 'surname_last';
  }
  return { name: [...order.map((i) => spelled[i]), ...suffixes].join(' '), source: 'safety', order: how };
}

module.exports = {
  displayName, wordsMatch, suffixCase, SUFFIX,
};
