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
const { weighConfidence, reliabilityOf, soleSourceIsUnreliable } = require('../../lib/decisions/sources');
const decisions = require('../../database/operationalDecisions');

function defaultDeps() {
  return { decisions };
}

/**
 * How each source has actually performed, cached for a pass.
 *
 * Measured from the journal's own graded outcomes, so it is empty until
 * decisions have been graded — and an empty record costs every source nothing,
 * which is the intended starting state rather than a degraded one.
 */
let reliabilityCache = { at: 0, bySource: {} };
const RELIABILITY_TTL_MS = 5 * 60 * 1000;

async function loadReliability(deps) {
  const now = Date.now();
  if (now - reliabilityCache.at < RELIABILITY_TTL_MS) return reliabilityCache.bySource;
  const raw = await deps.decisions.sourceAgreement?.({ sinceDays: 90 }).catch(() => ({})) || {};
  const bySource = {};
  for (const [source, stats] of Object.entries(raw)) bySource[source] = reliabilityOf(stats);
  reliabilityCache = { at: now, bySource };
  return bySource;
}

/** For tests, and for a caller that has just graded a batch. */
function clearReliabilityCache() {
  reliabilityCache = { at: 0, bySource: {} };
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
  // WHAT THE EVIDENCE IS WORTH, before what it says. Quality may only lower
  // the rule's own number — see lib/decisions/sources.js for why nothing here
  // can raise one.
  const reliability = await loadReliability(deps);
  const weighed = weighConfidence({ base: confidence, sources, reliability });

  let verdict = decide({
    sources, confidence: weighed.confidence, minConfidence, mode,
  });

  // AND A FLOOR, which is not the same as a penalty. When the only thing
  // speaking for an action is a source we have MEASURED as usually wrong, that
  // is an absence of evidence rather than weak evidence, so it cannot be
  // lowered into acceptability by a generous threshold.
  if (verdict.verdict === VERDICTS.ACT && soleSourceIsUnreliable(sources, reliability)) {
    verdict = {
      ...verdict,
      verdict: VERDICTS.HOLD,
      reason: 'the only source speaking for this is one measured as usually wrong',
    };
  }

  // ACT plus AUTOPILOT plus not-shadow. Three conditions, one flag, computed
  // in one place — a caller that had to combine them itself is a caller that
  // eventually gets one wrong in one branch.
  const mayAct = verdict.verdict === VERDICTS.ACT && shadow !== true;

  // The weighing's own reasons travel WITH the evidence, so a decision read
  // back months later says why its confidence was what it was rather than only
  // what it was.
  //
  // BOUND ONCE AND REUSED BY `acted` BELOW. It was built inline here and `acted`
  // re-recorded the BARE `evidence`, so the moment a decision was carried out
  // its weighing was overwritten — and an applied decision is exactly the one
  // whose reasoning somebody later wants. The rows that kept their explanation
  // were the ones where nothing happened.
  const recordedEvidence = weighed.reasons.length
    ? { ...evidence, weighing: weighed.reasons }
    : evidence;

  const row = await deps.decisions.recordDecision({
    checkKey, subjectType, subjectId, personId,
    verdict: verdict.verdict,
    confidence: verdict.confidence,
    mode: verdict.mode,
    shadow: shadow === true,
    reason: verdict.reason,
    evidence: recordedEvidence,
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
        reason: verdict.reason, evidence: recordedEvidence, sources,
        actionKey, correctionId,
      }).catch(() => null);
      return Boolean(updated);
    },
  };
}

module.exports = { takeDecision, clearReliabilityCache };
