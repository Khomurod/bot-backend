'use strict';

/**
 * Who a hashtag decides about. Pure — no model.
 *
 * `#Approved` under a post with one driver is that driver. In a team post it
 * must say WHO: "#Approved Darnell", "#NotApproved Calvin 3 accidents", or
 * "#Approved both". A team hashtag that names nobody is not guessed at —
 * Safety is asked (`which_of_team`), because "approved" for the wrong one of
 * two drivers is the mistake this whole feature exists to prevent. The same
 * driver given two different hashtags is asked about too (`conflict`).
 *
 * A driver is named by a word of their name the other driver does not share
 * (lib/safetyApprovals/reading.js `namedBy`), so "Brooks" names neither of
 * Darnell and Calvin Brooks.
 */

const { namedBy, tokensOf, PLURAL } = require('./reading');
const { reasonFrom } = require('./trigger');

/** The segment's words after the driver's own name: "#NotApproved Calvin 3 accidents" → "3 accidents". */
function reasonFor(candidate, text) {
  const own = new Set(tokensOf(candidate.name));
  const words = String(text || '').split(/\s+/);
  while (words.length && (own.has(words[0].toLowerCase().replace(/[^a-z]/g, '')) || /^(?:both|all)[,.:]?$/i.test(words[0]))) {
    words.shift();
  }
  return reasonFrom(words.join(' '));
}

/**
 * @param {{decision: string, text: string}[]} segments   lib/safetyApprovals/trigger.js
 * @param {{key: string, name: string}[]} candidates      the post's drivers
 * @returns {{decisions: object[]} | {ask: 'which_driver'|'which_of_team'|'conflict'}}
 */
function decideByHashtag(segments, candidates) {
  if (!candidates.length) return { ask: 'which_driver' };
  const byKey = new Map();
  for (const segment of segments) {
    const named = candidates.filter((c) => namedBy(c, candidates.filter((o) => o !== c), [segment.text]));
    let targets = named;
    if (!targets.length && candidates.length === 1) targets = candidates;
    if (!targets.length && PLURAL.test(segment.text)) targets = candidates;
    if (!targets.length) return { ask: 'which_of_team' };
    for (const candidate of targets) {
      const held = byKey.get(candidate.key);
      if (held && held.decision !== segment.decision) return { ask: 'conflict' };
      byKey.set(candidate.key, { ...candidate, decision: segment.decision, reason: reasonFor(candidate, segment.text) });
    }
  }
  return { decisions: [...byKey.values()] };
}

module.exports = { decideByHashtag, reasonFor };
