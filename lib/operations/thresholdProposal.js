'use strict';

/**
 * Turning "this check keeps being wrong" into a number somebody can agree to.
 *
 * PURE. Graded decisions in, a concrete proposal out. No database, no model, no
 * writes, and nothing here can change a setting.
 *
 * WHAT WAS MISSING. The learning pass could already say a check's decisions
 * were not holding up, and its advice about the confidence floor was a
 * paragraph: "raising the confidence this check needs would also reduce this —
 * what that number should be is a judgement". True, and useless. An
 * administrator cannot agree with a paragraph, and nothing became a
 * configuration change, so the same advice reappeared every week.
 *
 * THE NUMBER IS DERIVED, NOT CHOSEN. Every decision this check acted on carries
 * the confidence it acted at, and verification later recorded whether it held.
 * So the question has an answer in the data: what is the LOWEST floor at which
 * this check's own record is acceptable? Sweep the observed confidence values,
 * and take the smallest one where decisions at or above it were confirmed often
 * enough. That is a measurement of this check's behaviour, not an opinion about
 * how cautious the business should be.
 *
 * IT CAN ONLY EVER PROPOSE MORE CAUTION. A floor that moved DOWN would grant
 * the machine more autonomy on the strength of its own report card, which is
 * the one shape nobody should build — `services/operations/learningActions.js`
 * refuses `enable_auto_apply` for exactly this reason. A check that looks too
 * STRICT is still worth saying out loud, and this module says it, but with no
 * action attached: loosening a safety margin is a person's decision, made in
 * the settings screen, with their name on it.
 *
 * AND NOT ENOUGH EVIDENCE IS NO PROPOSAL. Under `minGraded` outcomes, or when
 * no floor would actually have helped, it returns null rather than a
 * confident-looking number computed from four rows.
 */

const DEFAULTS = {
  /** Graded decisions needed before this check's record means anything. */
  minGraded: 8,
  /** The confirm rate a floor has to reach to be worth proposing. */
  targetConfirmRate: 0.8,
  /** Below this, the current floor is already fine and nothing is proposed. */
  poorConfirmRate: 0.7,
  /** Never propose a floor above this — 100 would stop the check acting at all. */
  maxFloor: 95,
  /** The global floor. A per-check value may never go below it. */
  globalFloor: 70,
  /** A proposal has to buy at least this much improvement to be worth a screen. */
  minImprovement: 0.1,
};

/**
 * @param {object} input
 * @param {string} input.checkKey
 * @param {Array<{confidence:number, outcome:string}>} input.graded
 * @param {number|null} [input.currentFloor]  the per-check floor, null = inherits global
 * @returns {null|{checkKey, currentFloor, suggestedFloor, evidence, expectedEffect,
 *                 direction, applicable}}
 */
function proposeConfidenceFloor({ checkKey, graded = [], currentFloor = null, options = {} } = {}) {
  const opts = { ...DEFAULTS, ...options };
  const rows = graded
    .filter((r) => Number.isFinite(Number(r?.confidence)) && isJudgement(r?.outcome))
    .map((r) => ({ confidence: Number(r.confidence), held: heldUp(r.outcome) }));

  if (rows.length < opts.minGraded) return null;

  // `currentFloor == null` FIRST, because `Number(null)` is 0 and `isFinite(0)`
  // is true — so an inherited floor read as ZERO, which let every decision
  // count as "at or above the floor" and made every candidate look like an
  // improvement. A null check that arrives one line too late is not a null
  // check.
  const floor = currentFloor == null || !Number.isFinite(Number(currentFloor))
    ? opts.globalFloor
    : Number(currentFloor);
  const atCurrent = rateAtOrAbove(rows, floor);

  // Already good enough. Nothing to say.
  if (atCurrent.rate >= opts.poorConfirmRate) {
    return tooStrictNote({ checkKey, rows, floor, opts, atCurrent });
  }

  // The lowest floor whose record clears the target, from the values actually
  // observed — never an invented round number.
  const candidates = [...new Set(rows.map((r) => r.confidence))]
    .filter((c) => c > floor && c <= opts.maxFloor)
    .sort((a, b) => a - b);

  for (const candidate of candidates) {
    const at = rateAtOrAbove(rows, candidate);
    // A floor that leaves the check nothing to act on is not an improvement, it
    // is a disguised switch-off — and there is already an honest action for
    // that.
    if (at.total < Math.max(3, Math.ceil(rows.length * 0.25))) continue;
    if (at.rate < opts.targetConfirmRate) continue;
    if (at.rate - atCurrent.rate < opts.minImprovement) continue;

    const heldBack = rows.filter((r) => r.confidence >= floor && r.confidence < candidate).length;
    return {
      checkKey,
      currentFloor: floor,
      currentFloorIsInherited: currentFloor == null,
      suggestedFloor: candidate,
      direction: 'raise',
      applicable: true,
      evidence: {
        graded: rows.length,
        confirmedAtCurrent: atCurrent.held,
        rateAtCurrent: pct(atCurrent.rate),
        confirmedAtSuggested: at.held,
        rateAtSuggested: pct(at.rate),
        actedAtSuggested: at.total,
      },
      expectedEffect: `Of the ${rows.length} decisions this check acted on, ${heldBack} would `
        + `have been held for a person instead. The rest held up ${pct(at.rate)}% of the time, `
        + `against ${pct(atCurrent.rate)}% today.`,
    };
  }

  return null;
}

/**
 * A check that refuses far more than it needs to.
 *
 * REPORTED, AND DELIBERATELY NOT APPLICABLE. Lowering a floor hands the machine
 * more autonomy, and no amount of its own evidence makes that its decision to
 * take. It becomes a sentence an administrator can accept — and accepting it
 * means "yes, and I will go and change it", which the screen says in those
 * words rather than pretending something happened.
 */
function tooStrictNote({ checkKey, rows, floor, opts, atCurrent }) {
  if (floor <= opts.globalFloor) return null;
  const below = rows.filter((r) => r.confidence < floor);
  if (below.length < opts.minGraded) return null;
  const belowRate = below.filter((r) => r.held).length / below.length;
  if (belowRate < opts.targetConfirmRate) return null;

  return {
    checkKey,
    currentFloor: floor,
    currentFloorIsInherited: false,
    suggestedFloor: null,
    direction: 'lower',
    // The whole point of the flag.
    applicable: false,
    evidence: {
      graded: rows.length,
      rateAtCurrent: pct(atCurrent.rate),
      heldBelowFloor: below.length,
      rateBelowFloor: pct(belowRate),
    },
    expectedEffect: `${below.length} decisions were held below the ${floor} floor, and `
      + `${pct(belowRate)}% of the comparable ones held up. The floor may be stricter than `
      + 'this check needs — but loosening it is a judgement about how much caution you want, '
      + 'so Wenze will not change it.',
  };
}

function isJudgement(outcome) {
  // `not_checked` and `expired` are "we could not judge", not "it was wrong".
  return outcome === 'confirmed' || outcome === 'contradicted' || outcome === 'reverted';
}
function heldUp(outcome) { return outcome === 'confirmed'; }

function rateAtOrAbove(rows, floor) {
  const at = rows.filter((r) => r.confidence >= floor);
  const held = at.filter((r) => r.held).length;
  return { total: at.length, held, rate: at.length ? held / at.length : 0 };
}

function pct(rate) { return Math.round(rate * 100); }

module.exports = { proposeConfidenceFloor, DEFAULTS };
