'use strict';

/**
 * The one way a background check decides something and the one way it is
 * recorded — deliberately the same call.
 *
 * WHY THEY ARE NOT SEPARATE. Every defect this project has fixed had the same
 * shape: two things that should agree, kept in step by nobody. A decision
 * function and a journal write that a caller has to remember to pair would
 * become that within a month — the interesting decisions (the holds, the "I do
 * not know yet"s) are exactly the ones a caller has no other reason to write
 * down, so those are the ones that would go unrecorded, and those are the ones
 * outcome learning needs.
 *
 *     const d = await takeDecision({
 *       checkKey: 'load_lifecycle.conflict', subjectType: 'load', subjectId: id,
 *       sources, confidence, minConfidence: 70, mode, shadow,
 *       evidence: { ... },
 *     });
 *     if (d.mayAct) { ...do it...; await d.acted('close_cycle', correctionId); }
 *
 * `mayAct` is the ONLY thing a caller should branch on. It is true for exactly
 * one verdict in one mode, and it is computed here rather than by the caller so
 * that "is this allowed" cannot drift from "what was recorded".
 *
 * SHADOW MODE IS HANDLED HERE TOO, for the same reason: a caller asked to
 * remember not to act would eventually forget. In shadow, `mayAct` is false
 * however good the evidence, and what it would have done is recorded instead.
 */
const { decide, VERDICTS } = require('../../lib/decisions/verdict');
const decisions = require('../../database/operationalDecisions');

function defaultDeps() {
  return { decisions };
}

/**
 * Reach a decision, record it, and hand back something a caller can act on.
 *
 * Never throws. A journal that can break the pass it observes is worse than no
 * journal — the rule the run ledger already follows.
 *
 * @returns {Promise<{verdict:string, confidence:number|null, reason:string,
 *   mode:string, shadow:boolean, mayAct:boolean, id:number|null,
 *   acted:Function}>}
 */
async function takeDecision({
  checkKey, subjectType, subjectId, personId = null,
  sources = [], confidence = null, minConfidence = 70,
  mode = 'suggest', shadow = false,
  evidence = {}, wouldHave = null,
} = {}, deps = defaultDeps()) {
  const verdict = decide({ sources, confidence, minConfidence, mode });

  // ACT plus AUTOPILOT plus not-shadow. Three conditions, one flag, computed
  // in one place — a caller that had to combine them itself is a caller that
  // eventually gets one wrong in one branch.
  const mayAct = verdict.verdict === VERDICTS.ACT && shadow !== true;

  const row = await deps.decisions.recordDecision({
    checkKey, subjectType, subjectId, personId,
    verdict: verdict.verdict,
    confidence: verdict.confidence,
    mode: verdict.mode,
    shadow: shadow === true,
    reason: verdict.reason,
    evidence,
    sources,
    // In shadow, what it WOULD have done is the entire output.
    wouldHave: shadow === true && verdict.verdict === VERDICTS.ACT
      ? (wouldHave || { note: 'would have acted' })
      : null,
  }).catch(() => null);

  const id = row?.id ?? null;

  return {
    ...verdict,
    shadow: shadow === true,
    mayAct,
    id,
    /**
     * Record that the action was actually taken, and what it produced.
     * Separate from the decision because the decision comes first and the
     * action can still fail.
     */
    async acted(actionKey, correctionId = null) {
      if (!id) return false;
      const updated = await deps.decisions.recordDecision({
        checkKey, subjectType, subjectId, personId,
        verdict: verdict.verdict, confidence: verdict.confidence,
        mode: verdict.mode, shadow: shadow === true,
        reason: verdict.reason, evidence, sources,
        actionKey, correctionId,
      }).catch(() => null);
      return Boolean(updated);
    },
  };
}

module.exports = { takeDecision };
