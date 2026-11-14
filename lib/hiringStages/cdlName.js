'use strict';

/**
 * Is the CDL the bot read the post's driver? And may its name stand in for a
 * name nobody typed? Pure. (Owner, 14 November 2026 —
 * docs/architecture/hiring-cdl-reading.md.)
 *
 *   The post names ONE driver for certain → the CDL's first and last name
 *     must be that name's words (each word equal ignoring case, or — both
 *     five letters or more — one letter edit apart, the rule
 *     lib/hiringStages/displayName.js already uses for Safety's spelling).
 *     A match writes the CDL's values; a mismatch writes NOTHING from it.
 *   The post names nobody → the CDL's name may be used to CREATE the
 *     candidate (owner approved), and the card says "name read from the CDL".
 *     A deal found by phone whose contact has a real name is still checked
 *     against that name.
 *   The post may be about more than one driver → the CDL is not read: which
 *     driver's licence it is would be a guess.
 */

const { readPostNames } = require('../safetyApprovals/postDetails');
const { wordsMatch, SUFFIX } = require('./displayName');
const { splitName, distinctPhones, REASONS } = require('./identity');
const { isPlaceholderContact } = require('./placeholder');
const { cdlFullName } = require('./cdlFields');

/**
 * What the post's typed name lets the CDL step do.
 * @returns {{state: 'certain', name: string} | {state: 'none'} | {state: 'team'}}
 */
function postNameState(postText) {
  const read = readPostNames(postText);
  if (read.team || read.names.length > 1 || read.doubtful > 1) return { state: 'team' };
  if (read.names.length === 1 && !read.doubtful) return { state: 'certain', name: read.names[0] };
  if (!read.names.length) return { state: 'none' };
  return { state: 'team' }; // one name and a second name-shaped line: maybe two drivers
}

/** A name's words, without suffixes and stray punctuation. */
function nameWords(text) {
  return String(text || '').split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
    .filter((w) => w && !SUFFIX.test(w));
}

/** Claim a post word for `word` (exact first, then one edit); a hyphenated word may match by its parts. */
function claim(word, post, used) {
  const free = (i) => !used.has(i);
  let at = post.findIndex((w, i) => free(i) && w.toLowerCase() === word.toLowerCase());
  if (at < 0) at = post.findIndex((w, i) => free(i) && wordsMatch(word, w));
  if (at >= 0) {
    used.add(at);
    return true;
  }
  const parts = word.split('-').filter(Boolean);
  return parts.length > 1 && parts.every((part) => claim(part, post, used));
}

/**
 * Does the CDL's first name (its first word) and last name (every word) name
 * the person in `nameText`?
 * @param {{first_name?: string, last_name?: string}} values  the checked CDL values
 */
function cdlNameMatches(values, nameText) {
  if (!values?.first_name || !values?.last_name) return false;
  const post = nameWords(nameText);
  const needed = [nameWords(values.first_name)[0], ...nameWords(values.last_name)].filter(Boolean);
  const used = new Set();
  return needed.length >= 2 && needed.every((word) => claim(word, post, used));
}

/**
 * @param {object} args
 * @param {object} args.values            the checked CDL values
 * @param {string|null} args.postName     the post's one certain name, if it has one
 * @param {object|null} [args.contact]    the deal's contact as read from Bitrix ({first, last, name})
 * @returns {'match'|'differs'|'cdl_only'|'no_name'}
 */
function crossCheckName({ values, postName, contact = null }) {
  if (!cdlFullName(values)) return 'no_name';
  if (postName) return cdlNameMatches(values, postName) ? 'match' : 'differs';
  if (contact && !isPlaceholderContact(contact)) {
    const whole = contact.name || [contact.first, contact.last].filter(Boolean).join(' ');
    return cdlNameMatches(values, whole) ? 'match' : 'differs';
  }
  return 'cdl_only';
}

/**
 * The candidate to CREATE when the post names nobody: the CDL's name and the
 * one phone a recruiter typed — the same shape as
 * lib/hiringStages/identity.js `candidateIdentity`, marked `fromCdl`.
 */
function identityFromCdl({ values, phones = [] }) {
  const refuse = (reason) => ({
    ok: false, reason, note: REASONS[reason], name: null,
  });
  const full = cdlFullName(values);
  const split = full ? splitName(full) : null;
  if (!split) return refuse('no_name');
  const distinct = distinctPhones(phones);
  if (!distinct.length) return refuse('no_phone');
  if (distinct.length > 1) return refuse('several_phones');
  return {
    ok: true, name: full, displayName: full, first: split.first, last: split.last, phone: distinct[0], fromCdl: true,
  };
}

module.exports = {
  postNameState, cdlNameMatches, crossCheckName, identityFromCdl,
};
