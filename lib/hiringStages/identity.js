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
 * TWO NAMES (owner, 13–14 November 2026). `name` is the post's, as written
 * ("PHILLIPS SAMUEL JAHBARI" → "Phillips Samuel Jahbari"): what a contact or
 * deal is FOUND by, and what the card shows. `displayName` is what a creation
 * WRITES — the post's words with Safety's own spelling and order where
 * Safety's message names the same driver (lib/hiringStages/displayName.js),
 * else the post's name unchanged. `first` / `last` split the display name:
 * the last word is the contact's LAST_NAME and the others its NAME, which is
 * not a guess at the surname beyond what displayName.js decided. A person
 * may correct it in Bitrix.
 */

const { readPostNames } = require('../safetyApprovals/postDetails');
const { nameParts } = require('./proposal');
const { displayName, suffixCase, SUFFIX } = require('./displayName');

const REASONS = Object.freeze({
  team: 'the post is about more than one driver',
  no_name: 'no driver\'s name could be read off the post',
  unsure_name: 'a name in the post is not clear',
  no_phone: 'no phone number was written for the driver',
  several_phones: 'the conversation has more than one phone number',
  name_mismatch: 'the name read from the conversation is not the post\'s name',
});

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
 * @param {string|null} [args.modelName] the verified name the model gave, if any —
 *   checked against the post, never used as a spelling
 * @param {string[]} [args.safetyTexts] what Safety's people typed in the conversation (rules only)
 * @returns {{ok: true, name: string, displayName: string, first: string, last: string, phone: string}
 *   | {ok: false, reason: string, note: string, name: string|null}} a refusal
 *   still carries the post's one certain name, if it has one, to search by
 */
function candidateIdentity({
  postText, phones = [], modelName = null, safetyTexts = [],
}) {
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
  if (!splitName(name)) return refuse('no_name');
  const display = displayName({ postName: name, safetyTexts }).name;
  const split = splitName(display);
  return {
    ok: true, name, displayName: display, first: split.first, last: split.last, phone: distinct[0],
  };
}

/**
 * The name written to Bitrix for the post's ONE certain driver — what a
 * creation writes and what ✏️ Rename offers — or null when the post has no
 * single, clear name of two words or more. Needs no phone and no model: a
 * placeholder deal found by phone is offered a name even where a creation
 * would be refused (two phones, say).
 * @param {{postText: string, safetyTexts?: string[]}} args
 * @returns {string|null}
 */
function certainDisplayName({ postText, safetyTexts = [] }) {
  const read = readPostNames(postText);
  if (read.team || read.doubtful || read.names.length !== 1 || !splitName(read.names[0])) return null;
  return displayName({ postName: read.names[0], safetyTexts }).name;
}

module.exports = {
  candidateIdentity, certainDisplayName, splitName, REASONS,
};
