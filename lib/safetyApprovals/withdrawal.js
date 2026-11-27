'use strict';

/**
 * Safety answering the bot's OWN post in the approvals topic. Pure.
 *
 * THE CASE (27 November 2026): the bot posted "APPROVED by Aubrey Davis"
 * under a candidate, and Aubrey answered that post "I did not approve him
 * yet". The bot read the answer as a decision about a post it had never seen
 * and asked her to reply to the recruiter's post — the one thing she had not
 * asked for — while the wrong APPROVED stayed up.
 *
 * Now (owner, 27 November 2026) a Safety reply to the bot's post:
 *
 *   says it was not a decision   → the post is marked WITHDRAWN, nothing else
 *     ("not yet", "I did not       is written, and the real decision, when it
 *     approve him", "wrong",       comes, is posted
 *     "mistake", "cancel")
 *   carries #Approved /          → read as a decision on the driver's ORIGINAL
 *     #NotApproved                 post, as if it had answered that post
 *   anything else ("ok", "👍")   → nothing at all
 *
 * No model is asked: these are a handful of plain phrases, and a wrong guess
 * either way costs less than a model's.
 */

const WITHDRAWAL = new RegExp([
  // "did not approve", "didn't approve him", "haven't decided", "not approved", "not cleared yet"
  "\\b(?:did\\s*n[o']?t|didn'?t|have\\s*n[o']?t|haven'?t|has\\s*n[o']?t|hasn'?t|never|not)\\s+"
    + '(?:\\w+\\s+){0,2}?(?:approv\\w*|decid\\w*|clear\\w*|hir\\w*)',
  '\\bnot\\s+yet\\b',
  '\\bstill\\s+(?:checking|waiting|reviewing|pending)\\b',
  '\\b(?:wrong|mistake|mistaken|error|cancel\\w*|withdraw\\w*|undo|remove|delete)\\b',
  '(?:^|[^\\p{L}])(?:не\\s+одобр\\p{L}*|ещ[её]\\s+нет|ошибк\\p{L}*|отмен\\p{L}*)',
].join('|'), 'iu');

/** The reply says the bot's post was not Safety's decision. */
function isWithdrawal(text) {
  return WITHDRAWAL.test(String(text || ''));
}

/** Safety's own words for the withdrawn post's note: verbatim, one line, at most 200 characters. */
function withdrawalNote(text) {
  const words = String(text || '').replace(/\s+/g, ' ').trim();
  if (!words) return null;
  return words.length > 200 ? `${words.slice(0, 199).trimEnd()}…` : words;
}

module.exports = { isWithdrawal, withdrawalNote };
