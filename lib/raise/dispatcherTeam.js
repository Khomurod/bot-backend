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
 *
 * THE BOARD ALSO WRITES TWO SHAPES THIS USED TO REFUSE, and refusing them put
 * real company drivers in Needs Review every week:
 *
 *   "x Franky"      a sorting marker, so the row lands where dispatch wants it
 *   "y Anthony"     in the spreadsheet. The name is Franky.
 *   "zAaron/Jack"   a marker glued to the name, AND two dispatchers on one
 *                   truck's row.
 *
 * `x Franky` failed because the given-name tier reads the FIRST word, "X" is
 * one letter, and one letter is below the floor that stops an initial matching
 * three people — so the tier never ran. `zAaron/Jack` failed worse: it
 * normalised to "ZAARON JACK" and offered "ZAARON" as a given name, a token no
 * human is called, which would have matched a dispatcher genuinely named
 * Zaaron.
 *
 * BOTH ARE HANDLED AS FALLBACKS, AND THAT IS THE SAFETY PROPERTY. The literal
 * label is resolved first, exactly as before. Only a label that came back
 * UNKNOWN — nothing matched, nothing was at stake — is re-read as marked or
 * multi-name. A label that already MATCHED cannot be changed by either pass,
 * and one that was AMBIGUOUS is never "rescued" into a guess. So the new
 * tolerance can turn a Needs Review into a placement; it can never turn a
 * correct placement into a different one.
 *
 * AND THE MULTI-NAME RULE IS UNANIMITY, NOT MAJORITY. Every name on the label
 * must resolve, and they must all name the same team. One unrecognised name
 * means Needs Review, because the name nobody knows may be a dispatcher on
 * another team who simply has not been registered — and placing the driver on
 * the team the OTHER name points at is precisely the wrong-team failure this
 * module exists to prevent.
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
  // A name written INSIDE the team's own name — "Jack" of "Aaron / Jack".
  TEAM_NAME_PART: 'team_name_part',
  TEAM_NAME_PART_GIVEN: 'team_name_part_given_name',
});

/**
 * HOW the label had to be read before it resolved. Evidence only — never a
 * reason to accept a weaker match. `LITERAL` is the label as dispatch typed it.
 */
const VIA = Object.freeze({
  LITERAL: 'literal',
  SORT_MARKER: 'sort_marker',
  MULTI_NAME: 'multi_name',
});

/**
 * Single letters dispatch puts in FRONT of a name to control row order in the
 * spreadsheet. They are not initials and not part of anybody's name.
 *
 * Only x, y and z, and only leading: those three are what the real board uses,
 * and a short allow-list cannot quietly eat a genuine initial the way a rule
 * like "drop any leading single letter" would ("J Smith" keeps its J).
 */
const SORT_MARKERS = Object.freeze(['X', 'Y', 'Z']);

/** What dispatch puts BETWEEN two dispatchers sharing one row. */
const NAME_SEPARATORS = /\s*(?:\/|\\|&|\+|,|;|\band\b)\s*/i;

/**
 * The separators that may split a TEAM'S NAME into aliases — NO COMMA.
 *
 * A TEAM NAME AND A BOARD LABEL ARE NOT EQUALLY SAFE TO SPLIT, and that is the
 * whole reason this exists separately. Splitting a board label wrongly costs a
 * REFUSAL: the parts have to be unanimous, so an unrecognised piece sends the
 * driver to Needs Review. Splitting a TEAM NAME wrongly costs a WRONG KEY — the
 * alias is indexed, and from then on any board cell carrying that word places a
 * driver on that team.
 *
 * The comma is the one separator that means two different things. It lists
 * people ("Aaron, Jack") and it writes ONE person surname-last ("John, Smith").
 * Reading the second as a list makes SMITH an alias, and a board cell reading
 * "Smith" then lands on John's team — exactly the surname-becomes-an-alias
 * failure this module refuses everywhere else. So a team name is split only on
 * marks that cannot mean anything but "and another person".
 *
 * A team genuinely named "Aaron, Jack" therefore contributes no aliases. It
 * still matches its own full name, and the fix if its members need aliases is
 * to write it "Aaron / Jack" or to add member rows — both of which say what is
 * meant instead of leaving it to a guess.
 */
const TEAM_NAME_SEPARATORS = /\s*(?:\/|\\|&|\+|;|\band\b)\s*/i;

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

    // EVERY NAME IN THE TEAM'S OWN NAME IS THAT TEAM.
    //
    // Production names its teams after the people who run them — "Aaron /
    // Jack", "Franky / Sam / Ali", "Anthony / Andy / James" — and
    // `dispatch_team_members` is EMPTY, so the member list contributes nothing.
    // Without this, only the FIRST name resolved, because the given-name tier
    // reads the first word: Aaron matched and Jack did not, Franky matched and
    // Sam and Ali did not. A board row reading "zAaron/Jack" then failed
    // unanimity on a name that was written on the team all along.
    //
    // This is not fuzzy matching. It reads the same explicit separators as a
    // board label, so a team called "Charles Whitfield" is one name and is
    // never split into CHARLES and WHITFIELD — a surname must not become an
    // alias. And because every alias goes through the same Set-keyed index, two
    // teams claiming one name is AMBIGUOUS exactly as it always was, not a
    // race between them.
    for (const part of splitDispatcherNames(team.name, TEAM_NAME_SEPARATORS) || []) {
      const partKey = normaliseLabel(part);
      add(full, partKey, team.id, MATCHED_ON.TEAM_NAME_PART);
      add(given, givenNameOf(partKey), team.id, MATCHED_ON.TEAM_NAME_PART_GIVEN);
    }

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
 * Drop a leading sorting marker, or return null when there is not one.
 *
 * TWO SHAPES, BOTH DELIBERATELY NARROW:
 *   "x Franky"    a marker standing alone in front of the name
 *   "zAaron"      a marker glued to it, which only counts when the RAW text
 *                 shows a LOWER-case x/y/z immediately followed by an
 *                 UPPER-case letter
 *
 * The case test is what keeps a real name safe. "Zachary" is Z followed by a
 * lower-case a, "Yusuf" is Y followed by u — neither is touched. An all-caps
 * board cell like "ZAARON" loses that signal, so it is NOT stripped and stays
 * Needs Review; guessing there could eat the first letter of a name.
 *
 * Something must be left behind: "x" on its own is not a dispatcher, and this
 * returns null rather than an empty label.
 */
function stripSortMarker(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;

  const glued = raw.match(/^([xyz])(?=[A-Z])(.+)$/);
  if (glued) return glued[2].trim() || null;

  const standalone = raw.match(/^([A-Za-z])[\s.\-_]+(.+)$/);
  if (standalone && SORT_MARKERS.includes(standalone[1].toUpperCase())) {
    return standalone[2].trim() || null;
  }
  return null;
}

/**
 * Split a label that names more than one dispatcher.
 *
 * Returns null when there is only one name, so a caller can tell "one name"
 * from "several" without comparing lengths. Each part is returned RAW, because
 * a part can carry its own sorting marker — "zAaron/Jack" is `zAaron` and
 * `Jack`, and the marker has to be stripped per part.
 *
 * A PART THAT IS PURE NOISE IS NOT A NAME, so it cannot make a label a list.
 * `normaliseLabel` already reduces "dispatch" and "team" to nothing, and
 * "Charles/dispatch" is one dispatcher with a word after him — but deciding
 * "is this a list?" from the RAW text saw the slash, treated `dispatch` as a
 * second person nobody could resolve, and left the driver off the roster. The
 * parts are therefore weighed AFTER normalisation and returned BEFORE it.
 */
function splitDispatcherNames(text, separators = NAME_SEPARATORS) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  const parts = raw
    .split(separators)
    .map((p) => p.trim())
    .filter((p) => p && normaliseLabel(p));
  return parts.length > 1 ? parts : null;
}

/**
 * Resolve one already-normalised label against the index. The strict two-tier
 * rule, unchanged: full name first, given name second, no fuzziness anywhere.
 *
 * Split out of `matchDispatcherToTeam` so the fallback passes below can reuse
 * exactly the same strictness. A fallback that resolved by looser rules than
 * the literal pass would be a second, weaker matcher wearing the same name.
 */
function resolveStrict(normalised, index, { givenNameTier = true } = {}) {
  const none = (decision, reason, extra = {}) => ({
    decision, teamId: null, matchedOn: null, candidates: [], reason, ...extra,
  });
  if (!normalised) return none(DECISION.EMPTY, 'the board names no dispatcher for this driver');

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
      candidates: [exact.teamId],
      reason: null,
    };
  }
  if (exact && exact.ambiguous) {
    return none(DECISION.AMBIGUOUS, 'more than one dispatch team answers to that name', {
      candidates: exact.teamIds,
    });
  }

  // THEN THE GIVEN NAME, which is what the board cell usually holds. Switched
  // off when the caller has already established the label names SEVERAL
  // dispatchers: the given name is the FIRST word, so on "Aaron/Nobody" this
  // tier would quietly answer "Aaron's team" and discard the name it could not
  // resolve.
  if (!givenNameTier) {
    return none(DECISION.UNKNOWN, 'no dispatch team is named after that dispatcher');
  }
  const byGiven = resolveTier(index.given, givenNameOf(normalised), index);
  if (byGiven && !byGiven.ambiguous) {
    return {
      decision: DECISION.MATCHED,
      teamId: byGiven.teamId,
      matchedOn: byGiven.matchedOn,
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

/**
 * Every name on a multi-name label must resolve, and they must agree.
 *
 * UNANIMITY, NOT MAJORITY, and the reason is the whole point of this module: a
 * name nobody recognises may be a dispatcher on ANOTHER team who has not been
 * registered yet, so placing the driver on the team the other name points at
 * would be the wrong-team failure. Two names pointing at two teams is the same
 * refusal from the other direction.
 */
function resolveEveryName(parts, index) {
  const teamIds = new Set();
  let matchedOn = null;
  for (const part of parts) {
    // THE SAME RULE AS THE WHOLE LABEL: only an UNKNOWN part is re-read with
    // its sorting marker stripped. Re-reading an AMBIGUOUS one would throw away
    // the more informative answer — which it did, reporting "Franky is not one
    // Wenze knows" when the truth was that two teams answer to Franky.
    const direct = resolveStrict(normaliseLabel(part), index);
    let verdict = direct;
    if (direct.decision === DECISION.UNKNOWN) {
      const unmarkedPart = stripSortMarker(part);
      if (unmarkedPart) {
        const retry = resolveStrict(normaliseLabel(unmarkedPart), index);
        if (retry.decision !== DECISION.UNKNOWN) verdict = retry;
      }
    }
    if (verdict.decision !== DECISION.MATCHED) {
      // AMBIGUOUS AND UNKNOWN STAY DIFFERENT ANSWERS even inside a list. A part
      // that two teams answer to is a naming collision to settle; a part nobody
      // answers to is a dispatcher nobody has registered. Both are Needs
      // Review, and the person reading it needs to know which.
      const ambiguousPart = verdict.decision === DECISION.AMBIGUOUS;
      return {
        decision: ambiguousPart ? DECISION.AMBIGUOUS : DECISION.UNKNOWN,
        teamId: null,
        matchedOn: null,
        candidates: [...new Set([...teamIds, ...(verdict.candidates || [])])],
        reason: ambiguousPart
          ? `the board names more than one dispatcher and "${part}" answers to more than one team`
          : `the board names more than one dispatcher and "${part}" is not one Wenze knows`,
      };
    }
    teamIds.add(verdict.teamId);
    if (!matchedOn) matchedOn = verdict.matchedOn;
  }
  if (teamIds.size !== 1) {
    return {
      decision: DECISION.AMBIGUOUS, teamId: null, matchedOn: null, candidates: [...teamIds],
      reason: 'the board names dispatchers from more than one team on this row',
    };
  }
  const [teamId] = [...teamIds];
  return {
    decision: DECISION.MATCHED, teamId, matchedOn, candidates: [teamId], reason: null,
  };
}

/**
 * Which dispatch team does this board dispatcher belong to?
 *
 * THREE PASSES, AND ONLY THE FIRST CAN DECIDE ANYTHING CONTESTED. The literal
 * label is resolved exactly as it always was; a MATCHED, AMBIGUOUS or EMPTY
 * answer is returned untouched. Only UNKNOWN — nothing matched, so nothing is
 * at stake — is re-read as a sorting-marked or multi-name label. That ordering
 * is what lets the board's real shapes be understood without any chance of
 * moving a driver who was already being placed correctly.
 *
 * @param {string} dispatcher  the board cell, verbatim
 * @param {Array}  teams       `[{ id, name, memberNames: [] }]`
 * @returns `{ decision, teamId, matchedOn, normalised, candidates, reason, via }`
 */
function matchDispatcherToTeam(dispatcher, teams) {
  const normalised = normaliseLabel(dispatcher);
  const index = indexTeams(teams);
  const unmarked = stripSortMarker(dispatcher);
  const parts = splitDispatcherNames(dispatcher) || splitDispatcherNames(unmarked);

  // PASS 1 — the whole label, as a FULL name. This is the strongest evidence
  // there is, and it runs first so a team genuinely named "Aaron/Jack" or
  // "Smith, John" is matched by its own name before anything tries to read the
  // punctuation as a list.
  const whole = resolveStrict(normalised, index, { givenNameTier: !parts });
  if (whole.decision !== DECISION.UNKNOWN) return { ...whole, normalised, via: VIA.LITERAL };

  // PASS 2 — SEVERAL DISPATCHERS ON ONE ROW, when the label is punctuated like
  // a list. This comes BEFORE the given-name tier, and the `givenNameTier`
  // switch above is what makes that real: the given name is the first word, so
  // "Aaron/Nobody" would otherwise resolve to Aaron's team and throw away the
  // name it could not place, and "Franky/Steven" would pick Franky over two
  // teams that genuinely disagree. Both must reach a person instead.
  if (parts) {
    const several = resolveEveryName(parts, index);
    return { ...several, normalised, via: VIA.MULTI_NAME };
  }

  // PASS 3 — A SORTING MARKER IS NOT PART OF A NAME. "x Franky" is Franky.
  if (unmarked) {
    const marked = resolveStrict(normaliseLabel(unmarked), index);
    if (marked.decision !== DECISION.UNKNOWN) {
      return { ...marked, normalised, via: VIA.SORT_MARKER };
    }
  }

  return { ...whole, normalised, via: VIA.LITERAL };
}

module.exports = {
  DECISION, MATCHED_ON, VIA, NOISE_WORDS, SORT_MARKERS, TEAM_NAME_SEPARATORS,
  normaliseLabel, givenNameOf, stripSortMarker, splitDispatcherNames,
  indexTeams, matchDispatcherToTeam,
};
