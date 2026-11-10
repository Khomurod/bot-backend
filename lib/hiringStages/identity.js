'use strict';

/**
 * Who a candidate conversation is about — certain enough to CREATE a Bitrix
 * contact and deal for? Pure.
 *
 * Finding a deal may lean on a name; creating one may not lean on anything
 * that could be somebody else. So a creation needs, all at once:
 *
 *   - ONE driver's name read off the recruiter's post without a model
 *     (lib/safetyApprovals/postDetails.js) — not a team, not a name in small
 *     letters that might be a second driver, not a post with no name;
 *   - ONE phone number a recruiter typed in the conversation — two numbers
 *     could be two people, and none leaves nothing strong to find the
 *     contact by later;
 *   - and, when the model named the driver, a name made of the post's words.
 *
 * Anything less returns the reason in plain words, shown on the "please
 * create it" request in the Bitrix topic, and nothing is created.
 *
 * THE NAME IS STORED AS WRITTEN. Posts write names in any order ("PHILLIPS
 * SAMUEL JAHBARI"), and which word is the surname is not guessed: the last
 * word is the contact's LAST_NAME and the others its NAME, so the deal finder
 * (first word of NAME and all of LAST_NAME among the posted words) finds it
 * again in any order. A person may correct it in Bitrix.
 */

const { readPostNames } = require('../safetyApprovals/postDetails');
const { nameParts } = require('./proposal');

const SUFFIX = /^(?:jr|sr|ii|iii|iv)\.?$/i;

const REASONS = Object.freeze({
  team: 'the post is about more than one driver',
  no_name: 'no driver\'s name could be read off the post',
  unsure_name: 'a name in the post is not clear',
  no_phone: 'no phone number was written for the driver',
  several_phones: 'the conversation has more than one phone number',
  name_mismatch: 'the name read from the conversation is not the post\'s name',
});

function suffixCase(word) {
  return /^(?:ii|iii|iv)\.?$/i.test(word) ? word.toUpperCase() : word;
}

/** "Phillips Samuel Jahbari" → { first: "Phillips Samuel", last: "Jahbari" }. */
function splitName(name) {
  const words = String(name || '').split(/\s+/).filter(Boolean);
  const plain = words.filter((w) => !SUFFIX.test(w));
  const suffixes = words.filter((w) => SUFFIX.test(w)).map(suffixCase);
  if (plain.length < 2) return null;
  return { first: plain.slice(0, -1).join(' '), last: [plain.at(-1), ...suffixes].join(' ') };
}

/**
 * @param {object} args
 * @param {string} args.postText        the recruiter's post, verbatim
 * @param {string[]} args.phones        ten-digit phones recruiters typed (lib/hiringStages/conversation.js)
 * @param {string|null} [args.modelName] the verified name the model gave, if any
 * @returns {{ok: true, name: string, first: string, last: string, phone: string}
 *   | {ok: false, reason: string, note: string, name: string|null}} a refusal
 *   still carries the post's one certain name, if it has one, to search by
 */
function candidateIdentity({ postText, phones = [], modelName = null }) {
  const read = readPostNames(postText);
  const certainName = !read.team && !read.doubtful && read.names.length === 1 ? read.names[0] : null;
  const refuse = (reason) => ({
    ok: false, reason, note: REASONS[reason], name: reason === 'name_mismatch' ? null : certainName,
  });
  if (read.team || read.names.length > 1) return refuse('team');
  if (read.doubtful) return refuse('unsure_name');
  if (!read.names.length) return refuse('no_name');
  const distinct = [...new Set(phones.map((p) => String(p).replace(/\D/g, '').slice(-10)).filter((p) => p.length === 10))];
  if (!distinct.length) return refuse('no_phone');
  if (distinct.length > 1) return refuse('several_phones');

  const [name] = read.names;
  const own = new Set(nameParts(name));
  if (modelName && !nameParts(modelName).every((w) => own.has(w))) return refuse('name_mismatch');
  const split = splitName(name);
  if (!split) return refuse('no_name');
  return {
    ok: true, name, first: split.first, last: split.last, phone: distinct[0],
  };
}

module.exports = { candidateIdentity, splitName, REASONS };
