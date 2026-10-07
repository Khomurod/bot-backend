'use strict';

/**
 * Which question is worth one of today's one or two. PURE.
 *
 * The owner's rule (2026-10-06): one or two important questions a day, each
 * with the reason it is being asked. Twenty asked and none answered is what
 * the old order — strictly oldest first — produced: a two-day-old chat retype
 * went out ahead of a held $1,200 bonus.
 *
 * THE ORDER: money first, then serious, then warning, then the rest; within
 * each, the one waiting longest. Everything not asked today stays on Needs
 * Attention and is considered again tomorrow.
 */

/** Questions whose answer decides whether somebody is paid. */
const MONEY_CHECKS = new Set(['home_time.road_bonus_review']);

function questionRank(finding) {
  if (MONEY_CHECKS.has(finding?.checkKey)) return 0;
  if (finding?.severity === 'serious') return 1;
  if (finding?.severity === 'warning') return 2;
  return 3;
}

/** A new array, most important first. */
function orderForAsking(findings = []) {
  return [...findings].sort((a, b) => {
    const r = questionRank(a) - questionRank(b);
    if (r !== 0) return r;
    return new Date(a.firstSeenAt || 0) - new Date(b.firstSeenAt || 0);
  });
}

const MAX_WHY = 180;

/**
 * The true reason each kind of question needs a person, for findings that do
 * not carry their own. Production, 2026-10-07: every approval question said
 * "it changes a driver's pay or records" — including ones that change neither
 * pay nor anything a driver would recognise. A reason that is the same on every
 * question is not a reason.
 */
const WHY_BY_CHECK = Object.freeze({
  'home_time.closable_open_cycle': 'the home stay was never closed, so this driver\'s history still shows them at home',
  'home_time.exhausted_internal_alerts': 'those staff alerts failed every retry; closing them stops them counting as stuck',
  'identity.group_without_person': 'without a permanent identity, this driver\'s history is lost if the chat is ever recreated',
  'identity.stale_unit_assignment': 'two records name different trucks, and only someone who knows can say which is current',
  'home_time.clock_reset_on_group_change': 'the road clock decides the road bonus, and it restarted when the chat was recreated',
  'identity.telegram_link': 'knowing which account is the driver lets Wenze tell their messages from the dispatcher\'s',
  'identity.telegram_member_unnamed': 'the Telegram name does not match the driver, so I will not guess that it is theirs',
  'board.person_link': 'linking the board row lets the dispatcher board and Wenze agree on who is in this truck',
  'board.person_link_suggested': 'only the name matches, and two people can share a name',
  'board.truck_disagrees_with_profile': 'the board and the profile name different trucks, and I cannot tell which is current',
  'board.team_person_needs_split': 'two drivers stored as one person mixes up their histories',
  'home_time.returned_to_road': 'moving a driver to Road starts their road clock, which the road bonus is counted from',
});

/**
 * Why Wenze is asking rather than doing, in one line. The finding's own
 * reason when it has one; then why it held back; then the reason this kind of
 * question needs a person; and only then what the tier means.
 */
function whyAsking(finding, { held = false } = {}) {
  const own = finding?.evidence?.reason;
  const byCheck = WHY_BY_CHECK[finding?.checkKey];
  let why;
  if (typeof own === 'string' && own.trim()) why = own.trim();
  else if (held) why = 'Wenze may fix this kind of thing, but the evidence this time was not strong enough';
  else if (byCheck) why = byCheck;
  else if (finding?.tier === 'approval') why = 'a person has to decide this one';
  else why = 'Wenze could fix this itself, but has not been allowed to act on this kind of thing yet';
  const clipped = why.length > MAX_WHY ? `${why.slice(0, MAX_WHY - 1).trimEnd()}…` : why;
  return `Why I'm asking: ${clipped}`;
}

module.exports = {
  MONEY_CHECKS, WHY_BY_CHECK, questionRank, orderForAsking, whyAsking,
};
