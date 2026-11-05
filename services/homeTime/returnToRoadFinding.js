'use strict';

/**
 * The finding the return-to-road watch files — its subject, its words, its
 * evidence. PURE. Split out of `./returnToRoadWatch.js`, which re-exports it,
 * when the evidence gained the fields a question needs (who, which truck, the
 * evidence in words) and the watch reached the 500-line limit.
 */

const CHECK_RETURNED = 'home_time.returned_to_road';
const CHECK_UNCLEAR = 'home_time.return_to_road_unclear';

/**
 * The subject is the HOME STAY, not the driver.
 *
 * A finding is unique on (check_key, subject_type, subject_id), and
 * `upsertFinding` reopens only a RESOLVED row. Keyed on the group, the first
 * return would be applied, the row would sit at `applied` forever, and the same
 * driver's NEXT return would quietly update that row instead of becoming a new
 * event nobody acts on. The open cycle names the stay; a driver with no cycle
 * to close is identified by when they went home.
 */
function subjectFor(driver) {
  if (driver.roadHistoryId) {
    return { subjectType: 'road_history', subjectId: String(driver.roadHistoryId) };
  }
  return { subjectType: 'group', subjectId: `${driver.groupId}@${driver.homeSince || 'unknown'}` };
}

function buildFinding(driver, verdict, { unit, eventAt }) {
  const high = verdict.confidence === 'high';
  const label = `${driver.driverName || driver.groupName || `Group ${driver.groupId}`}`
    + `${unit ? ` (Unit ${unit})` : ''}`;
  return {
    checkKey: high ? CHECK_RETURNED : CHECK_UNCLEAR,
    ...subjectFor(driver),
    title: high
      ? `${label} looks back on the road — ${verdict.summary}`
      : `${label}: unclear whether they are back on the road — ${verdict.summary}`,
    severity: high ? 'info' : 'warning',
    tier: high ? 'auto' : 'warning',
    confidence: Math.max(0, Math.min(100, verdict.score)),
    evidence: {
      homeSince: driver.homeSince,
      // For the question: who, which truck, and the evidence in words.
      driverName: driver.driverName || null,
      groupName: driver.groupName || null,
      unitNumber: unit || null,
      summary: verdict.summary || null,
      signals: verdict.signals,
      blockers: verdict.blockers,
      ...verdict.facts,
      // WHO DECIDED, recorded beside WHAT was decided. The correction is
      // audited against this finding, so without these the trail could not say
      // whether a model was involved at all, which one, or what it said — and
      // "the software moved a driver" is exactly the claim that needs answering
      // months later. `aiAssisted: false` is written explicitly rather than
      // left absent, because an absent field reads as "nobody recorded it".
      aiAssisted: verdict.aiAssisted === true,
      aiProvider: verdict.aiProvider || null,
      aiModel: verdict.aiModel || null,
      aiConfidence: verdict.aiConfidence ?? null,
      aiReason: verdict.aiReason || null,
      decidedAutomatically: true,
    },
    proposedChange: high
      ? {
        groupId: driver.groupId,
        personId: driver.personId || null,
        cycleId: driver.roadHistoryId || null,
        returnToRoadAt: eventAt,
        evidenceSummary: verdict.summary,
      }
      : null,
  };
}

module.exports = {
  CHECK_RETURNED, CHECK_UNCLEAR, subjectFor, buildFinding,
};
