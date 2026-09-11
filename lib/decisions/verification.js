'use strict';

/**
 * Did the thing we did actually hold?
 *
 * WHY THIS IS NOT THE DECIDER'S JOB. A decision that graded its own homework
 * would be worth nothing, and worse, it would be worth nothing while LOOKING
 * like a track record — which is exactly what `lib/decisions/sources.js` then
 * reads to decide how much to trust a source. A feedback loop fed by
 * self-assessment is a machine agreeing with itself in a circle.
 *
 * So verification happens later, from the live rows, and compares what was
 * WRITTEN against what is THERE.
 *
 * FOUR OUTCOMES, and the distinction between the middle two is the one that
 * matters:
 *
 *   confirmed     what we wrote is still there, and the evidence still supports it
 *   contradicted  it is no longer true
 *   expired       the subject is gone, or too much time has passed to judge
 *   not_checked   nothing here knows how to verify this action. An HONEST answer,
 *                 and far better than grading it `confirmed` because nothing
 *                 objected
 *
 * AND SOMEBODY ELSE CHANGING IT IS NOT A REASON TO CHANGE IT BACK. When the
 * values we wrote have been altered by a person, the decision is contradicted —
 * a human disagreed, which is information — but the correction must NOT be
 * reverted. Reverting there would mean software and a person taking turns
 * overwriting each other, and the software would win because it never gets
 * bored. `shouldRollBack` is false for exactly that case.
 *
 * WHICH MEANS NO AUTOMATIC ROLLBACK CAN FIRE TODAY, and that is worth stating
 * plainly rather than leaving somebody to discover it.
 *
 * `compareWritten` can only reach `contradicted` by finding a value different
 * from the one we wrote — and it cannot tell who changed it, so it says
 * `someone`, and `shouldRollBack` refuses. The one contradiction this pass can
 * detect is therefore the one it must never undo.
 *
 * The guard is still here, fully built and tested, because the case it is for
 * is real and simply not detectable yet: a correction whose values are intact
 * but whose JUSTIFYING EVIDENCE has since evaporated. Detecting that means
 * re-deriving the evidence, which is a second decision engine and deliberately
 * out of this module's scope — see `services/decisions/verifyPass.js`.
 *
 * It is written this way round on purpose. A rollback path that LOOKS live and
 * is not is the defect this repository keeps finding; one that is documented as
 * not-yet-reachable is a foundation.
 */

const OUTCOMES = Object.freeze({
  CONFIRMED: 'confirmed',
  CONTRADICTED: 'contradicted',
  EXPIRED: 'expired',
  NOT_CHECKED: 'not_checked',
  // Recorded INSTEAD of `contradicted` when the pass undid it, so the journal
  // distinguishes "this turned out wrong" from "this turned out wrong and we
  // put it back". The reliability model counts both against the source either
  // way — see `sourceAgreement` — but a person reading the row needs to know
  // whether anything was done about it.
  REVERTED: 'reverted',
});

/**
 * Compare what a correction claimed to write against what is there now.
 *
 * @param {object} input
 * @param {Record<string, any>|null} input.wrote   the correction's new_values
 * @param {Record<string, any>|null} input.current the same fields, read live
 * @returns {{outcome:string, changedBy:'nobody'|'someone'|'unknown', detail:string,
 *   fields:string[]}}
 */
function compareWritten({ wrote = null, current = null } = {}) {
  if (!wrote || typeof wrote !== 'object' || !Object.keys(wrote).length) {
    return {
      outcome: OUTCOMES.NOT_CHECKED,
      changedBy: 'unknown',
      detail: 'the correction recorded no values, so there is nothing to check it against',
      fields: [],
    };
  }
  if (current == null) {
    return {
      outcome: OUTCOMES.EXPIRED,
      changedBy: 'unknown',
      detail: 'the subject no longer exists',
      fields: [],
    };
  }

  const differing = [];
  for (const [field, value] of Object.entries(wrote)) {
    if (!(field in current)) continue;
    if (!sameValue(value, current[field])) differing.push(field);
  }

  if (!differing.length) {
    return {
      outcome: OUTCOMES.CONFIRMED,
      changedBy: 'nobody',
      detail: 'every value this correction wrote is still in place',
      fields: [],
    };
  }
  return {
    outcome: OUTCOMES.CONTRADICTED,
    changedBy: 'someone',
    detail: `${differing.join(', ')} no longer hold${differing.length === 1 ? 's' : ''} `
      + 'what this correction wrote',
    fields: differing,
  };
}

/** Timestamps, numbers and strings compared by value rather than identity. */
function sameValue(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) return aTime === bTime;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}

/**
 * May this be rolled back automatically?
 *
 * FOUR CONDITIONS, ALL REQUIRED, and each rules out a different way an
 * automatic rollback goes wrong:
 *
 *   the outcome is `contradicted`      nothing else is a reason to undo anything
 *   nobody else changed it             or software and a person take turns
 *                                      overwriting each other, and the software
 *                                      wins because it never gets bored
 *   the action DECLARES itself safe    opt-in per action, defaulting to no
 *   it has not been reverted already   a second revert is not idempotent, it is
 *                                      a re-application of the thing we undid
 */
function shouldRollBack({ verdict, action = null, alreadyReverted = false } = {}) {
  if (alreadyReverted) return { rollBack: false, why: 'it has already been reverted' };
  if (verdict?.outcome !== OUTCOMES.CONTRADICTED) {
    return { rollBack: false, why: `nothing to undo — the outcome is ${verdict?.outcome}` };
  }
  if (verdict.changedBy === 'someone') {
    return {
      rollBack: false,
      why: 'a person changed this after we did; undoing it would be arguing with them',
    };
  }
  if (!action || action.autoRevert !== true) {
    return { rollBack: false, why: 'this action is not declared safe to undo automatically' };
  }
  return { rollBack: true, why: 'the evidence that justified it no longer holds' };
}

module.exports = { OUTCOMES, compareWritten, sameValue, shouldRollBack };
