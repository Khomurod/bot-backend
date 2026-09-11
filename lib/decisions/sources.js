'use strict';

/**
 * What a reading is worth — freshness, thinness, and a measured track record.
 *
 * THE RULE THAT SHAPES THIS WHOLE MODULE: evidence quality may only LOWER a
 * confidence, never raise one. There is no path here by which stacking more
 * sources, or sources that have been right before, pushes a rule past the
 * number its own logic reached. That asymmetry is deliberate. A system that
 * could talk itself up would eventually act on five weak agreements the way it
 * acts on one strong one, and five sources reading the same stale GPS feed are
 * not five pieces of evidence — they are one, counted five times.
 *
 * THREE THINGS ARE MEASURED, and they answer different questions:
 *
 *   freshness    was this reading current enough for THIS question? A fuel
 *                percentage an hour old is fine; a position an hour old is not,
 *                which is why the window is the caller's to name and not a
 *                constant here
 *   thinness     how much was actually read? One source agreeing with itself
 *                is not corroboration
 *   reliability  has this source been right BEFORE? Measured from the decision
 *                journal's own graded outcomes, never assumed
 *
 * AND AN UNMEASURED SOURCE IS NOT AN UNRELIABLE ONE. A source with no track
 * record is used at full weight. Only a source with a MEASURED bad record is
 * discounted, because "we have never checked" and "we checked and it was wrong"
 * are different facts and the first must not be punished like the second — the
 * same distinction `unknown` and `hold` draw one module over.
 */

/** Below this measured agreement rate, a source stops being able to decide alone. */
const POOR_AGREEMENT = 0.6;
/** A track record shorter than this is not a track record. */
const MIN_GRADED = 5;

/**
 * Normalise one reading into the shape `assessEvidence` consumes.
 *
 * @param {object} input
 * @param {string} input.source        what was read, e.g. 'samsara', 'board'
 * @param {string|null} [input.at]     when it was captured (ISO)
 * @param {number} input.freshForMinutes  how long a reading stays current FOR
 *   THIS QUESTION. The caller names it because the answer differs per question:
 *   a position goes stale in minutes, a home-time request in days.
 * @param {boolean|null} [input.agrees]  null means "no opinion", which is not
 *   disagreement
 * @param {string|null} [input.now]
 */
function describeSource({ source, at = null, freshForMinutes = 60, agrees = null, now = null } = {}) {
  const nowMs = now ? Date.parse(now) : Date.now();
  const atMs = at ? Date.parse(at) : NaN;
  const ageMinutes = Number.isFinite(atMs) && Number.isFinite(nowMs)
    ? Math.max(0, (nowMs - atMs) / 60000)
    : null;

  return {
    source: String(source || 'unknown'),
    at: at || null,
    ageMinutes: ageMinutes == null ? null : Math.round(ageMinutes),
    // A reading with NO timestamp is not fresh. It might be current, and we
    // cannot say so — and "cannot say" has to travel as not-fresh or the
    // caller silently treats an undated reading as a current one.
    fresh: ageMinutes != null && ageMinutes <= freshForMinutes,
    agrees: agrees === true || agrees === false ? agrees : null,
  };
}

/**
 * How a source has actually performed, from graded decisions.
 *
 * @param {{graded:number, confirmed:number}|null} stats
 * @returns {{known:boolean, graded:number, agreementRate:number|null, poor:boolean}}
 */
function reliabilityOf(stats) {
  const graded = Number(stats?.graded) || 0;
  if (graded < MIN_GRADED) {
    // NOT zero, and not a penalty. Never having been checked is an absence of
    // information about the source, not information against it.
    return { known: false, graded, agreementRate: null, poor: false };
  }
  const confirmed = Number(stats?.confirmed) || 0;
  const rate = confirmed / graded;
  return {
    known: true,
    graded,
    agreementRate: Math.round(rate * 100) / 100,
    poor: rate < POOR_AGREEMENT,
  };
}

/**
 * Confidence after the evidence is weighed. Only ever lower than `base`.
 *
 * @param {object} input
 * @param {number|null} input.base  what the rule's own logic reached
 * @param {Array} input.sources     from `describeSource`
 * @param {Record<string, object>} [input.reliability] source → `reliabilityOf`
 * @returns {{confidence:number|null, reasons:string[]}}
 */
function weighConfidence({ base = null, sources = [], reliability = {} } = {}) {
  const reasons = [];
  if (!Number.isFinite(base)) return { confidence: null, reasons: ['the rule reached no confidence'] };

  const read = (sources || []).filter(Boolean);
  let score = Number(base);

  const stale = read.filter((s) => s.fresh === false);
  if (stale.length) {
    // Proportional: one stale source among four is a smaller problem than one
    // among two. Capped so that staleness alone cannot zero a confidence —
    // that case is `unknown`, and it is `assessEvidence`'s to return.
    const share = stale.length / read.length;
    const penalty = Math.round(40 * share);
    score -= penalty;
    reasons.push(`${stale.length} of ${read.length} readings were stale (-${penalty})`);
  }

  const opinions = read.filter((s) => s.agrees === true);
  if (opinions.length === 1 && read.length === 1) {
    score -= 10;
    reasons.push('only one source had an opinion, so nothing corroborates it (-10)');
  }

  for (const s of read) {
    const r = reliability[s.source];
    if (r && r.poor) {
      score -= 25;
      reasons.push(
        `${s.source} has agreed with the outcome ${Math.round(r.agreementRate * 100)}% of `
        + `the time over ${r.graded} graded decisions (-25)`
      );
    }
  }

  const finalScore = Math.max(0, Math.min(Number(base), Math.round(score)));
  return { confidence: finalScore, reasons };
}

/**
 * A source whose measured record is poor may not be the ONLY thing acted on.
 *
 * Separate from the confidence penalty on purpose. Lowering a number is a
 * judgement that can still clear a threshold; this is a floor. "The one source
 * saying yes is the one we have measured as usually wrong" is not a weaker
 * version of good evidence, it is an absence of it.
 */
function soleSourceIsUnreliable(sources = [], reliability = {}) {
  const speaking = (sources || []).filter((s) => s && s.fresh !== false && s.agrees === true);
  if (speaking.length !== 1) return false;
  return Boolean(reliability[speaking[0].source]?.poor);
}

module.exports = {
  POOR_AGREEMENT,
  MIN_GRADED,
  describeSource,
  reliabilityOf,
  weighConfidence,
  soleSourceIsUnreliable,
};
