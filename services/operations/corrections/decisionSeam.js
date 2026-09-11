'use strict';

/**
 * Turning a planned correction into a recorded decision.
 *
 * WHY THIS IS A SEAM AND NOT THREE LINES IN THE BATCH. `takeDecision` was
 * written as "the one way a background check decides something and the one way
 * it is recorded", and then NOTHING CALLED IT — nineteen passing tests and no
 * production caller, so `operational_decisions` was never written, the
 * verification pass graded an empty table every hour and reported healthy, and
 * the source-reliability model had no data and stayed decoration for ever.
 *
 * This is the caller. It lives in its own file because the batch is about
 * guardrails and ordering, and this is about what a correction rests on — and
 * because the batch was already past the length at which this repository
 * starts splitting.
 */
const { takeDecision } = require('../../decisions/journal');

/**
 * How confident a check must be before the journal lets it act.
 *
 * SEVENTY IS BELOW EVERY CHECK THAT CAN ACT TODAY, and the margin is smaller
 * than the raw numbers suggest — which is the arithmetic worth writing down
 * rather than rediscovering.
 *
 * The checks with a registered action file at 85, 90, 95 and 100. Each then
 * loses 10 to `weighConfidence`, because one check observing something is one
 * source and nothing corroborates it:
 *
 *     home_time.returned_to_road          85 → 75     ← the tightest, 5 to spare
 *     identity.group_without_person       90 → 80
 *     identity.stale_unit_assignment      90 → 80
 *     home_time.ghost_home_status         90 → 80
 *     home_time.closable_open_cycle    90/95 → 80/85
 *     identity.status_disagreement        95 → 85
 *     home_time.exhausted_internal_alerts 100 → 90
 *
 * So nothing that works today stops working, and a check that later files below
 * 80 will be held. That is the intended behaviour and not an accident: routing
 * corrections through the journal must RECORD what they do, and a floor that
 * silently disabled a working repair would be a regression wearing the clothes
 * of a safety feature. Raising this number without re-reading that table is how
 * the fleet stops being repaired.
 *
 * A held correction is not lost. The finding stays open on Needs Attention and
 * a person can still apply it by hand — the route does not come through here.
 */
const MIN_CONFIDENCE = 70;

/**
 * How long a finding's observation counts as current.
 *
 * The sweep re-derives every open finding every fifteen minutes, so a finding
 * not seen for two hours means the sweep stopped or the condition went away —
 * and acting on either is acting on something nobody has checked lately.
 * `assessEvidence` turns an all-stale reading into `unknown`, NEVER into
 * `hold`: "nobody has looked" and "the evidence says no" are opposite answers.
 */
const EVIDENCE_FRESH_MS = 2 * 60 * 60 * 1000;

/**
 * What this correction rests on, in the shape the journal grades.
 *
 * ONE SOURCE, HONESTLY. The check observed the condition and wrote a finding;
 * that is one reading, not three, and inflating it into a list would make
 * agreement look like corroboration. The action re-derives from the live rows
 * under `FOR UPDATE` before writing, but that happens AFTER this decision, so
 * it is not evidence the decision may count.
 *
 * Naming the source per check is what makes the reliability model work at all:
 * `sourceAgreement` measures how often decisions citing each source were later
 * confirmed, so a check whose corrections keep getting reverted becomes a
 * source the journal stops acting on alone. With one shared source name that
 * feedback would be fleet-wide and useless.
 */
function sourcesFor(finding, now = Date.now()) {
  const seen = Date.parse(finding?.lastSeenAt || '');
  return [{
    source: `check:${finding.checkKey}`,
    at: finding.lastSeenAt || null,
    fresh: Number.isFinite(seen) ? (now - seen) <= EVIDENCE_FRESH_MS : false,
    agrees: true,
  }];
}

/**
 * One decision, recorded, for one planned correction.
 *
 * The mode comes from the SETTINGS ROW, which is the owner's word, and not from
 * the fact that the batch got this far — those agree today and a helper that
 * re-derived it from "we are in the apply loop" would make them agree by
 * construction, which is how two things that should agree stop being checked.
 */
function recordDecisionFor(item, { shadow, takeDecision: take = takeDecision }) {
  const { finding, action, payload, mode } = item;
  return take({
    checkKey: finding.checkKey,
    subjectType: finding.subjectType,
    subjectId: finding.subjectId,
    personId: finding.evidence?.personId ?? null,
    sources: sourcesFor(finding),
    confidence: finding.confidence,
    minConfidence: MIN_CONFIDENCE,
    mode,
    shadow,
    evidence: {
      findingId: finding.id,
      actionKey: action.key,
      title: finding.title,
      severity: finding.severity,
    },
    // In shadow this is the entire output: what it would have changed, in the
    // action's own words, so a trial can be read without re-deriving anything.
    wouldHave: shadow ? { actionKey: action.key, describe: action.describe(payload) } : null,
  });
}

module.exports = { MIN_CONFIDENCE, EVIDENCE_FRESH_MS, sourcesFor, recordDecisionFor };
