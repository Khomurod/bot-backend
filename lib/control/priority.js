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
 * Why Wenze is asking rather than doing, in one line. The finding's own
 * reason when it has one; otherwise what the tier means.
 */
function whyAsking(finding, { held = false } = {}) {
  const own = finding?.evidence?.reason;
  let why;
  if (typeof own === 'string' && own.trim()) why = own.trim();
  else if (held) why = 'Wenze may fix this kind of thing, but the evidence this time was not strong enough';
  else if (finding?.tier === 'approval') why = 'it changes a driver\'s pay or records, so a person decides';
  else why = 'Wenze could fix this itself, but has not been allowed to act on this kind of thing yet';
  const clipped = why.length > MAX_WHY ? `${why.slice(0, MAX_WHY - 1).trimEnd()}…` : why;
  return `Why I'm asking: ${clipped}`;
}

module.exports = { MONEY_CHECKS, questionRank, orderForAsking, whyAsking };
