'use strict';

/**
 * The four answers Wenze is allowed to give about whether to act.
 *
 * THE SEPARATION THIS MODULE EXISTS TO KEEP. A decision has two halves that
 * must never be confused:
 *
 *   what the EVIDENCE permits   — deterministic, from our own recorded data
 *   what the OWNER permits      — the mode, set per check in the admin
 *
 * AI contributes to neither. It may rank, explain and draft; it cannot widen
 * what evidence permits, and it cannot raise a mode. `tests/decisionVerdict.js`
 * asserts that the function taking the decision has no parameter through which
 * a model's opinion could arrive — the same shape as `evaluateSuspension` in
 * the policy watcher, and for the same reason.
 *
 * `hold` AND `unknown` ARE OPPOSITES, not neighbours on a scale.
 *
 *   hold     the evidence is against acting. A real answer, arrived at by
 *            reading data that was there
 *   unknown  the evidence is MISSING. Not an answer at all
 *
 * Any model that reduces confidence to one number collapses these two, because
 * both come out low. "The truck is clearly still at the shipper" and "nobody
 * has heard from this truck since Tuesday" call for opposite actions, and
 * conflating them is exactly how a stale feed becomes an inactivity report —
 * the failure this application already has a name for.
 */

/** @type {Readonly<{ACT:'act', SUGGEST:'suggest', HOLD:'hold', UNKNOWN:'unknown'}>} */
const VERDICTS = Object.freeze({
  ACT: 'act',
  SUGGEST: 'suggest',
  HOLD: 'hold',
  UNKNOWN: 'unknown',
});

/** What the owner has permitted for a check. Widening order, lowest first. */
const MODES = Object.freeze({
  OBSERVE: 'observe',
  SUGGEST: 'suggest',
  AUTOPILOT: 'autopilot',
});

const MODE_ORDER = Object.freeze([MODES.OBSERVE, MODES.SUGGEST, MODES.AUTOPILOT]);

/**
 * Is this enough to act on at all, before the owner's permission is consulted?
 *
 * Deliberately conservative and deliberately NOT a single threshold on a score.
 * Three things must all hold, and each can fail for its own reason:
 *
 *   1. something was actually read        (no sources → `unknown`)
 *   2. what was read was current enough   (all stale → `unknown`, never `hold`)
 *   3. the readings agree                 (disagreement → `hold`, never a guess)
 *
 * Rule 3 is the one worth being loud about: when two sources contradict each
 * other, the answer is NOT the more confident source. It is that a person must
 * look. Picking a side here is what puts one driver's alert on another
 * driver's phone.
 *
 * @param {object} input
 * @param {Array<{source:string, at?:string|null, fresh?:boolean, agrees?:boolean|null}>} input.sources
 * @param {number|null} [input.confidence] 0-100, from the caller's own rule
 * @param {number} [input.minConfidence] the caller's floor for acting
 * @returns {{verdict:string, confidence:number|null, reason:string}}
 */
function assessEvidence({ sources = [], confidence = null, minConfidence = 70 } = {}) {
  const read = Array.isArray(sources) ? sources.filter(Boolean) : [];

  if (read.length === 0) {
    return {
      verdict: VERDICTS.UNKNOWN,
      confidence: null,
      reason: 'nothing was read, so there is nothing to decide from',
    };
  }

  const fresh = read.filter((s) => s.fresh !== false);
  if (fresh.length === 0) {
    return {
      verdict: VERDICTS.UNKNOWN,
      confidence: null,
      // NOT `hold`. A truck nobody has heard from is not a truck standing
      // still, and this sentence is the difference between asking after a
      // driver and reporting them idle.
      reason: `everything read was stale (${read.length} source(s)), which says `
        + 'nothing about what is true now',
    };
  }

  // `agrees: null` is "this source has no opinion", which is not disagreement.
  const opinions = fresh.filter((s) => s.agrees === true || s.agrees === false);
  const against = opinions.filter((s) => s.agrees === false);
  if (against.length > 0 && against.length < opinions.length) {
    return {
      verdict: VERDICTS.HOLD,
      confidence: null,
      reason: `${opinions.length} sources were read and they disagree `
        + `(${against.map((s) => s.source).join(', ')} say otherwise), so this is `
        + 'a question for a person rather than a decision',
    };
  }
  if (against.length > 0) {
    return {
      verdict: VERDICTS.HOLD,
      confidence: null,
      reason: 'the evidence is against it',
    };
  }

  const score = Number.isFinite(confidence) ? Number(confidence) : null;
  if (score === null) {
    return {
      verdict: VERDICTS.UNKNOWN,
      confidence: null,
      reason: 'the rule reached no confidence, which is not the same as a low one',
    };
  }
  if (score < minConfidence) {
    return {
      verdict: VERDICTS.HOLD,
      confidence: score,
      reason: `confidence ${score} is under the ${minConfidence} this check acts on`,
    };
  }
  return {
    verdict: VERDICTS.ACT,
    confidence: score,
    reason: `${fresh.length} source(s) agree, at confidence ${score}`,
  };
}

/**
 * What the owner's mode does to an evidence verdict. It can only NARROW.
 *
 * There is deliberately no path by which a mode turns `hold` or `unknown` into
 * `act`. A switch in an admin panel is permission to act on evidence that
 * already supports acting; it is not evidence. Autopilot on a check that cannot
 * tell what is true must still do nothing, and a test holds that line.
 */
function applyMode(evidenceVerdict, mode) {
  const v = evidenceVerdict?.verdict;
  const known = MODE_ORDER.includes(mode) ? mode : MODES.SUGGEST;

  if (v !== VERDICTS.ACT) return { ...evidenceVerdict, mode: known };

  if (known === MODES.OBSERVE) {
    return {
      ...evidenceVerdict,
      verdict: VERDICTS.HOLD,
      mode: known,
      reason: `${evidenceVerdict.reason} — but this check is in Observe, so nothing is done`,
    };
  }
  if (known === MODES.SUGGEST) {
    return {
      ...evidenceVerdict,
      verdict: VERDICTS.SUGGEST,
      mode: known,
      reason: `${evidenceVerdict.reason} — a person decides`,
    };
  }
  return { ...evidenceVerdict, mode: known };
}

/** The whole decision: evidence first, then permission. Never the other way. */
function decide({ sources, confidence, minConfidence, mode } = {}) {
  return applyMode(assessEvidence({ sources, confidence, minConfidence }), mode);
}

module.exports = { VERDICTS, MODES, MODE_ORDER, assessEvidence, applyMode, decide };
