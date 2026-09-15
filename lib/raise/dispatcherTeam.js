'use strict';

/**
 * "The board says Charles. Which dispatch team is that?" PURE.
 *
 * THE WHOLE DIFFICULTY IS THAT THE BOARD WRITES A PERSON AND THE RAISE REVIEW
 * NEEDS A TEAM. Dispatch types a name into a spreadsheet cell — "Charles",
 * "charles", "Team Charles", "Charles W." — and the review round is submitted
 * by a TEAM. Something has to cross that gap, and how forgiving it is decides
 * whether a driver lands on the right roster or somebody else's.
 *
 * SO THE RULE IS: FORGIVING ABOUT SPELLING, NEVER ABOUT IDENTITY.
 *
 * Case, extra spaces, punctuation and the words dispatch writes around a name
 * ("Team", "Disp", "Dispatcher") are noise and are removed. What is left must
 * then match a team's name or one of its dispatchers EXACTLY. There is no edit
 * distance, no substring test, no "closest match" — because the failure those
 * buy is a driver's raise reviewed by the wrong team, and nobody notices until
 * the pay is wrong.
 *
 * TWO TIERS, AND THE ORDER MATTERS. A full name is stronger evidence than a
 * given name, so full names are resolved first. Only when nothing matches in
 * full is the given name tried — which is the common real case, because the
 * board cell usually holds just "Charles". If two teams both have a Charles,
 * the given name is genuinely ambiguous and this says so rather than picking
 * the first one.
 *
 * AMBIGUOUS AND UNKNOWN ARE DIFFERENT ANSWERS and both are returned as
 * themselves. "I found two" and "I found none" need different things from a
 * person: one is a naming collision to settle, the other is a dispatcher
 * nobody has told Wenze about.
 */

const DECISION = Object.freeze({
  MATCHED: 'matched',
  AMBIGUOUS: 'ambiguous',
  UNKNOWN: 'unknown',
  EMPTY: 'empty',
});

/** How the match was reached — carried into the evidence, never into the logic. */
const MATCHED_ON = Object.freeze({
  TEAM_NAME: 'team_name',
  MEMBER_NAME: 'member_name',
  MEMBER_GIVEN_NAME: 'member_given_name',
  TEAM_GIVEN_NAME: 'team_given_name',
});

/**
 * Words dispatch writes AROUND a name rather than as part of one.
 *
 * Stripped from both ends. "Team Charles", "Charles team" and "DISP - Charles"
 * are all one dispatcher called Charles; a team genuinely named "Team" would
 * normalise to nothing and is refused by the empty guard rather than matching
 * everything.
 */
const NOISE_WORDS = Object.freeze([
  'TEAM', 'TEAMS', 'DISPATCH', 'DISPATCHER', 'DISPATCHERS', 'DISP', 'DSP', 'DISPATCHING',
]);

/**
 * Reduce a written label to the letters that identify a person.
 *
 * Accents are folded because a name typed with and without them is the same
 * name; everything that is not a letter, a digit or a single separating space
 * goes. The result is uppercase so comparison never depends on how somebody
 * held the shift key.
 */
function normaliseLabel(text) {
  const base = String(text == null ? '' : text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  if (!base) return '';
  let words = base.split(/\s+/).filter(Boolean);
  // Strip the noise words from the FRONT and the BACK only. One in the middle
  // ("Charles Team Two") is part of how somebody named the thing.
  while (words.length && NOISE_WORDS.includes(words[0])) words = words.slice(1);
  while (words.length && NOISE_WORDS.includes(words[words.length - 1])) words = words.slice(0, -1);
  return words.join(' ');
}

/** The first word of a normalised label, when it is long enough to identify anybody. */
function givenNameOf(normalised) {
  const first = String(normalised || '').split(' ')[0] || '';
  // Two letters is an initial, not a name. "JO" would match three people.
  return first.length >= 3 ? first : null;
}

/**
 * Build the lookup a match runs against.
 *
 * @param {Array} teams  `[{ id, name, memberNames: [] }]` — active teams and
 *   the dispatchers on them.
 * @returns `{ full: Map<key, Set<teamId>>, given: Map<key, Set<teamId>>, meta }`
 */
function indexTeams(teams) {
  const full = new Map();
  const given = new Map();
  const how = new Map();

  const add = (map, key, teamId, matchedOn) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(teamId);
    const metaKey = `${key}|${teamId}`;
    // The strongest reason wins when one key is reachable two ways.
    if (!how.has(metaKey)) how.set(metaKey, matchedOn);
  };

  for (const team of teams || []) {
    if (!team || team.id == null) continue;
    const teamKey = normaliseLabel(team.name);
    add(full, teamKey, team.id, MATCHED_ON.TEAM_NAME);
    add(given, givenNameOf(teamKey), team.id, MATCHED_ON.TEAM_GIVEN_NAME);

    for (const raw of team.memberNames || []) {
      const memberKey = normaliseLabel(raw);
      add(full, memberKey, team.id, MATCHED_ON.MEMBER_NAME);
      add(given, givenNameOf(memberKey), team.id, MATCHED_ON.MEMBER_GIVEN_NAME);
    }
  }
  return { full, given, how };
}

function resolveTier(map, key, index) {
  if (!key || !map.has(key)) return null;
  const ids = [...map.get(key)];
  if (ids.length !== 1) return { ambiguous: true, teamIds: ids };
  return { ambiguous: false, teamId: ids[0], matchedOn: index.how.get(`${key}|${ids[0]}`) || null };
}

/**
 * Which dispatch team does this board dispatcher belong to?
 *
 * @param {string} dispatcher  the board cell, verbatim
 * @param {Array}  teams       `[{ id, name, memberNames: [] }]`
 * @returns `{ decision, teamId, matchedOn, normalised, candidates, reason }`
 */
function matchDispatcherToTeam(dispatcher, teams) {
  const normalised = normaliseLabel(dispatcher);
  const none = (decision, reason, extra = {}) => ({
    decision, teamId: null, matchedOn: null, normalised, candidates: [], reason, ...extra,
  });

  if (!normalised) return none(DECISION.EMPTY, 'the board names no dispatcher for this driver');

  const index = indexTeams(teams);

  // FULL NAMES FIRST. "Charles Whitfield" on the board must not be decided by
  // whichever team happens to own the given name Charles.
  const exact = resolveTier(index.full, normalised, index);
  if (exact && !exact.ambiguous) {
    // ONE WORD IS NOT A FULL NAME, even when a team is spelled exactly that
    // way. A board cell reading "Sam" matches the team called Sam AND the
    // first name of Sam Porter on another team, and those are two different
    // dispatchers; the full-name tier only earns its priority when the label
    // actually carries more than a first name. Without this, the driver joins
    // whichever team happens to be named after the word.
    const collision = givenNameOf(normalised) === normalised
      ? resolveTier(index.given, normalised, index)
      : null;
    if (collision && collision.ambiguous) {
      return none(DECISION.AMBIGUOUS, 'more than one dispatch team answers to that name', {
        candidates: collision.teamIds,
      });
    }
    return {
      decision: DECISION.MATCHED,
      teamId: exact.teamId,
      matchedOn: exact.matchedOn,
      normalised,
      candidates: [exact.teamId],
      reason: null,
    };
  }
  if (exact && exact.ambiguous) {
    return none(DECISION.AMBIGUOUS, 'more than one dispatch team answers to that name', {
      candidates: exact.teamIds,
    });
  }

  // THEN THE GIVEN NAME, which is what the board cell usually holds.
  const byGiven = resolveTier(index.given, givenNameOf(normalised), index);
  if (byGiven && !byGiven.ambiguous) {
    return {
      decision: DECISION.MATCHED,
      teamId: byGiven.teamId,
      matchedOn: byGiven.matchedOn,
      normalised,
      candidates: [byGiven.teamId],
      reason: null,
    };
  }
  if (byGiven && byGiven.ambiguous) {
    return none(DECISION.AMBIGUOUS, 'more than one dispatch team has a dispatcher with that first name', {
      candidates: byGiven.teamIds,
    });
  }

  return none(DECISION.UNKNOWN, 'no dispatch team is named after that dispatcher');
}

module.exports = {
  DECISION, MATCHED_ON, NOISE_WORDS,
  normaliseLabel, givenNameOf, indexTeams, matchDispatcherToTeam,
};
