'use strict';

/**
 * A road bonus held for a person. PURE.
 *
 * The road-bonus poller holds a leg's bonus when the trip was longer than six
 * weeks (`lib/homeTime/roadBonusDecision.js`) — the owner's rule, because an
 * inflated road clock produces exactly that shape, and a long trip is
 * sometimes real. A hold that only lived in a table would never be paid and
 * never be refused; this is what puts it in front of somebody, on Needs
 * Attention and as a Yes/No question in Telegram.
 *
 * APPROVAL TIER, ONE ACTION: release it. Approving moves the leg to `released`
 * and the poller posts the summary within ten minutes. Dismissing the finding
 * pays nothing — the leg stays held.
 */

const CHECK_KEYS = ['home_time.road_bonus_review'];

/** Matches the loader's ceiling; a truncated read is refused, never filed. */
const MAX_REVIEWS = 500;

function runRoadBonusChecks(snapshot) {
  const legs = snapshot?.roadBonusReviews;
  // A READ THAT FAILED IS NOT "NOTHING HELD". Throwing excludes these keys
  // from resolution, so an outage never clears a held bonus off the screen.
  if (!Array.isArray(legs)) throw new Error('held road bonuses could not be read');
  if (legs.length >= MAX_REVIEWS) {
    throw new Error(`${legs.length} held road bonuses is at the read ceiling — the picture is partial`);
  }

  return legs.map((leg) => {
    const who = [leg.driver_name, leg.unit_number ? `Unit ${leg.unit_number}` : null]
      .filter(Boolean).join(', ') || `Group ${leg.group_id}`;
    const bonus = Number(leg.bonus_usd) || 0;
    const days = Number(leg.days_on_road) || 0;
    return {
      checkKey: 'home_time.road_bonus_review',
      subjectType: 'road_history',
      subjectId: String(leg.id),
      title: `${who}: $${bonus.toFixed(0)} road bonus for ${days} days on the road — check before paying`,
      severity: 'warning',
      tier: 'approval',
      confidence: 70,
      evidence: {
        roadHistoryId: leg.id,
        groupId: leg.group_id,
        driverName: leg.driver_name || null,
        unitNumber: leg.unit_number || null,
        daysOnRoad: days,
        exceededWeeks: Number(leg.exceeded_weeks) || 0,
        homeDays: leg.home_days == null ? null : Number(leg.home_days),
        bonusUsd: bonus,
        roadStartedAt: leg.road_started_at || null,
        homeArrivedAt: leg.home_arrived_at || null,
        reason: leg.bonus_decision_reason || null,
        note: 'Approving posts the bonus summary to the road-bonus group. '
          + 'Dismissing pays nothing.',
      },
      proposedChange: { roadHistoryId: leg.id, bonusUsd: bonus, to: 'released' },
    };
  });
}

module.exports = { CHECK_KEYS, MAX_REVIEWS, runRoadBonusChecks };
