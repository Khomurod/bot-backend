/**
 * A finding's proposed change → the arguments its action takes. Pure.
 *
 * Split out of `autoApply.js`, which re-exports it unchanged, when that file
 * neared the size limit; this is its own responsibility — one mapping per check
 * key — and it grows with every action the registry gains.
 *
 * Reads ONLY the finding's own `proposedChange`, which the pure check built from
 * recorded evidence. Nothing is recomputed here — the action itself re-derives
 * the answer from the live rows before it writes anything, which is where a
 * proposal that has gone stale is caught.
 *
 * BOTH `POST /findings/:id/apply` and `runAutoCorrections` come through here, so
 * a check key this function does not know has a registered action that can never
 * run: the route answers "no proposed change" and the batch counts it under
 * `skipped.noPayload`. Registering an action is half of wiring it up; this is
 * the other half.
 */
function payloadFor(finding) {
  const change = finding.proposedChange || {};
  if (finding.checkKey === 'home_time.closable_open_cycle') {
    return {
      cycleId: change.id,
      returnToRoadAt: change.returnToRoadAt?.to ?? null,
      homeDays: change.homeDays?.to ?? null,
    };
  }
  if (finding.checkKey === 'identity.status_disagreement'
      || finding.checkKey === 'identity.status_needs_decision') {
    return change.groupId && change.to ? { groupId: change.groupId, toStatus: change.to } : null;
  }
  if (finding.checkKey === 'identity.group_without_person') {
    return change.groupId ? { groupId: change.groupId } : null;
  }
  if (finding.checkKey === 'home_time.clock_reset_on_group_change') {
    return change.groupId && change.to
      ? {
        groupId: change.groupId, fromStateSince: change.from, toStateSince: change.to,
        fromGroupId: change.fromGroupId, personId: change.personId ?? null,
        roadBonusWeeksNotified: change.roadBonusWeeksNotified?.to ?? null,
      }
      : null;
  }
  if (finding.checkKey === 'identity.stale_unit_assignment') {
    return change.personId && change.to
      ? { personId: change.personId, unitNumber: change.to, groupId: change.groupId }
      : null;
  }
  if (finding.checkKey === 'identity.unit_handover') {
    return change.personId && change.unitNumber && change.groupId
      ? {
        personId: change.personId, groupId: change.groupId, unitNumber: change.unitNumber,
        holderPersonIds: change.holderPersonIds || [],
      }
      : null;
  }
  if (finding.checkKey === 'identity.telegram_link'
      || finding.checkKey === 'identity.telegram_member_unnamed') {
    // The unnamed case has no proposal of its own — a person approving it is
    // approving THE candidate the check saw, so the payload is rebuilt from the
    // evidence and the apply re-derives it anyway.
    return change.personId && change.telegramUserId
      ? {
        groupId: change.groupId, personId: change.personId, telegramUserId: change.telegramUserId,
        confirmedUnnamed: finding.checkKey === 'identity.telegram_member_unnamed',
      }
      : null;
  }
  if (finding.checkKey === 'home_time.road_bonus_review') {
    const id = change.roadHistoryId || finding.evidence?.roadHistoryId;
    return id ? { roadHistoryId: id } : null;
  }
  if (finding.checkKey === 'identity.non_driver_typed_as_driver') {
    return change.groupId || finding.evidence?.groupId
      ? { groupId: change.groupId || finding.evidence.groupId, toType: 'company' }
      : null;
  }
  if (finding.checkKey === 'home_time.returned_to_road') {
    return change.groupId && change.returnToRoadAt
      ? {
        groupId: change.groupId,
        returnToRoadAt: change.returnToRoadAt,
        evidenceSummary: change.evidenceSummary || null,
      }
      : null;
  }
  if (finding.checkKey === 'home_time.exhausted_internal_alerts') {
    // Empty is NO payload, not an empty one: the batch then counts it under
    // `skipped.noPayload` rather than calling an action with nothing to do.
    const ids = Array.isArray(change.requestIds) ? change.requestIds : [];
    return ids.length ? { requestIds: ids } : null;
  }
  return null;
}

module.exports = { payloadFor };
