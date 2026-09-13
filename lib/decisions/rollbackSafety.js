'use strict';

/**
 * May Wenze put something back the way it was, without asking? PURE.
 *
 * WHY THIS MODULE EXISTS. `lib/decisions/verification.js` could reach exactly
 * one contradiction — a value that no longer matches what we wrote — and could
 * not tell WHO changed it, so it said `someone` and refused every time. The
 * machinery was complete and unreachable: the only contradiction it could
 * detect was the one it must never undo. This module supplies the two things
 * that were missing, and neither of them is a new decision engine.
 *
 * ONE: WHERE DID THE CONFLICTING CHANGE COME FROM. Read from the trail the
 * application already keeps — `operational_corrections` records an initiator on
 * every applied correction, `admin_audit_log` records who touched what. A
 * person after us is a HUMAN OVERRIDE and is never undone: software and a
 * person taking turns overwriting each other is a fight the software wins,
 * because it never gets bored. Nothing found at all is UNKNOWN ORIGIN, and is
 * also never undone — the audit trail does not cover every write path in this
 * application, so absence of evidence here is genuinely absence of knowledge.
 *
 * TWO: DID THE REASON EVAPORATE. The case automatic rollback is actually for is
 * the opposite one: our values are intact, nobody has touched them, and the
 * operational evidence that justified writing them is no longer true. Detecting
 * that needs the action's OWN evidence derivation — the same one its `apply`
 * already re-runs under lock before writing — asked read-only. That is why
 * `stillJustified` is declared per action rather than computed here: a general
 * re-derivation would be a second decision engine disagreeing with the first at
 * a different hour of the day.
 *
 * WHAT MAY NEVER BE UNDONE AUTOMATICALLY, whatever any flag says: anything
 * touching employment, pay, discipline, safety consequences, hiring or
 * rejection, or legal and compliance state. That is not a per-action judgement
 * call left to whoever edits the registry next — every action DECLARES its
 * impact class, a test asserts each one has declared it, and only `operational`
 * is ever eligible. An action added without a class is refused rather than
 * assumed harmless.
 *
 * AND AMBIGUITY IS NOT A ROLLBACK. Every path that cannot prove all of the
 * above ends at `requires_human_review`, never at an undo.
 */

/** Where a conflicting change came from. */
const ORIGINS = Object.freeze({
  HUMAN: 'human',
  SYSTEM: 'system',
  UNKNOWN: 'unknown',
});

/**
 * What verification concluded. Six states, because the four the journal had
 * could not tell "a person disagreed" from "we cannot tell who did this" from
 * "the reason stopped being true" — and those want three different responses.
 */
const VERDICTS = Object.freeze({
  VERIFIED: 'verified_correct',
  CONTRADICTED_BY_EVIDENCE: 'contradicted_by_evidence',
  HUMAN_OVERRIDE: 'human_override',
  UNKNOWN_ORIGIN: 'unknown_origin',
  REVERTED: 'automatically_reverted',
  NEEDS_REVIEW: 'requires_human_review',
});

/**
 * The only impact class an automatic undo may ever touch.
 *
 * The others are enumerated so that adding one is a deliberate act with this
 * list in front of you, and so a test can assert the set has not quietly grown.
 */
const IMPACT_CLASSES = Object.freeze([
  'operational',   // a link, a cycle, an assignment snapshot — reversible, no consequence to a person
  'employment',    // status, hiring, rejection, termination
  'pay',           // rates, bonuses, deductions
  'discipline',    // warnings, fines, safety consequences
  'compliance',    // legal, DOT, retention obligations
]);
const AUTO_REVERTABLE_IMPACT = 'operational';

/** How many times one subject may be put back before a person is asked instead. */
const MAX_AUTOMATIC_REVERTS = 1;

/**
 * Who changed it after we did.
 *
 * `initiator` is `system` for an automatic correction and `admin:<id>` or
 * `telegram:<id>` for a person — see `corrections/apply.js initiatorFor`. Any
 * audit row at all means a person went through an admin route.
 */
function classifyOrigin({ laterCorrections = [], laterAudits = [] } = {}) {
  if (laterAudits.length) {
    return { origin: ORIGINS.HUMAN, detail: `${laterAudits.length} admin action(s) touched this after we did` };
  }
  const byPerson = laterCorrections.filter((c) => c.initiator && c.initiator !== 'system');
  if (byPerson.length) {
    return { origin: ORIGINS.HUMAN, detail: `changed by ${byPerson[0].initiator}` };
  }
  if (laterCorrections.length) {
    return { origin: ORIGINS.SYSTEM, detail: 'changed by another automatic correction' };
  }
  return {
    origin: ORIGINS.UNKNOWN,
    // Said plainly, because this is the common case and it must not read like a
    // clean bill of health: the trail does not cover every write path.
    detail: 'nothing in the audit trail explains the change, so its origin is unknown',
  };
}

/**
 * The whole question, in one place.
 *
 * @param {object} input
 * @param {{outcome:string, fields:string[], detail:string}} input.comparison  from compareWritten
 * @param {{origin:string, detail:string}} [input.origin]       from classifyOrigin
 * @param {{holds:boolean, reason:string}|null} [input.stillJustified]
 * @param {{autoRevert?:boolean, impact?:string}|null} [input.action]
 * @param {boolean} [input.alreadyReverted]
 * @param {number}  [input.priorReverts]
 * @returns {{verdict:string, rollBack:boolean, why:string}}
 */
function assessRollback({
  comparison, origin = null, stillJustified = null, action = null,
  alreadyReverted = false, priorReverts = 0, maxReverts = MAX_AUTOMATIC_REVERTS,
} = {}) {
  const no = (verdict, why) => ({ verdict, rollBack: false, why });

  if (alreadyReverted) return no(VERDICTS.NEEDS_REVIEW, 'it has already been reverted once');

  // ── the values were changed by somebody ──────────────────────────────────
  if (comparison?.outcome === 'contradicted') {
    if (origin?.origin === ORIGINS.HUMAN) {
      return no(VERDICTS.HUMAN_OVERRIDE,
        `a person changed this after we did (${origin.detail}); undoing it would be arguing with them`);
    }
    if (origin?.origin === ORIGINS.SYSTEM) {
      // Our own automation moved it. Undoing that is the start of an
      // oscillation, not a correction.
      return no(VERDICTS.NEEDS_REVIEW,
        'another automatic correction changed this; putting it back would set the two fighting');
    }
    return no(VERDICTS.UNKNOWN_ORIGIN, origin?.detail
      || 'nothing explains who changed this, and an unexplained change is never undone');
  }

  if (comparison?.outcome === 'expired') return no(VERDICTS.NEEDS_REVIEW, 'the subject is gone');
  if (comparison?.outcome === 'not_checked') {
    return no(VERDICTS.NEEDS_REVIEW, 'nothing here knows how to verify this action');
  }

  // ── the values are intact; did the REASON survive? ───────────────────────
  if (!stillJustified) {
    // The action declares no evidence re-read, so "still there" is all we know
    // and all we claim.
    return no(VERDICTS.VERIFIED, 'every value this correction wrote is still in place');
  }
  if (stillJustified.holds !== false) {
    return no(VERDICTS.VERIFIED, stillJustified.reason || 'the evidence still supports it');
  }

  // The reason evaporated. Now, and only now, is an undo on the table.
  if (!action || action.impact !== AUTO_REVERTABLE_IMPACT) {
    return no(VERDICTS.NEEDS_REVIEW,
      `the evidence no longer holds, and a ${action?.impact || 'unclassified'} action is never `
      + 'undone automatically');
  }
  if (action.autoRevert !== true) {
    return no(VERDICTS.NEEDS_REVIEW,
      'the evidence no longer holds, but this action is not declared safe to undo automatically');
  }
  if (priorReverts >= maxReverts) {
    return no(VERDICTS.NEEDS_REVIEW,
      `this subject has already been put back ${priorReverts} time(s); a person should look`);
  }

  return {
    verdict: VERDICTS.REVERTED,
    rollBack: true,
    why: stillJustified.reason || 'the operational evidence that justified this no longer holds',
  };
}

module.exports = {
  ORIGINS, VERDICTS, IMPACT_CLASSES, AUTO_REVERTABLE_IMPACT, MAX_AUTOMATIC_REVERTS,
  classifyOrigin, assessRollback,
};
