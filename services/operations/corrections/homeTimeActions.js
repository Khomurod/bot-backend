/**
 * Carrying a road clock across a truck change — an APPROVAL action.
 *
 * Tier `approval`, never `auto`: `state_since` drives the extra-week bonus, so
 * this changes a future payout, and only a person can confirm the driver did not
 * go home between the two chats. The value itself is copied, not computed — the
 * old chat's `state_since`, exactly as `driver_home_status` recorded it.
 *
 * The extra-week watermark travels with the clock: the old chat may already have
 * announced N completed weeks, and carrying the start date back without carrying
 * the watermark would announce them again into the new chat.
 */
const { StaleCorrectionError, sameInstant, assertUnchangedSince } = require('./evidence');

const carryRoadClock = {
  key: 'home_time.carry_road_clock',
  tier: 'approval',
  subjectType: 'group',
  describe: (p) => `Carry the road clock on group ${p.groupId} back to ${p.toStateSince} (from group ${p.fromGroupId})`,

  async apply({ groupId, fromStateSince, toStateSince, fromGroupId, roadBonusWeeksNotified = null }, client) {
    const rows = await client.query(
      `SELECT group_id, state, state_since, road_bonus_weeks_notified
         FROM driver_home_status WHERE group_id = ANY($1::int[]) ORDER BY group_id FOR UPDATE`,
      [[groupId, fromGroupId].filter((v) => v != null)]
    );
    const target = rows.rows.find((r) => r.group_id === Number(groupId));
    const source = rows.rows.find((r) => r.group_id === Number(fromGroupId));
    if (!target) throw new StaleCorrectionError(`Group ${groupId} has no home-time status row.`);
    if (target.state !== 'road') throw new StaleCorrectionError(`Group ${groupId} is no longer on the road.`);
    if (!sameInstant(target.state_since, fromStateSince)) {
      throw new StaleCorrectionError(`Group ${groupId}'s clock moved since the proposal — leaving it alone.`);
    }
    if (!source || !sameInstant(source.state_since, toStateSince)) {
      throw new StaleCorrectionError(`Group ${fromGroupId}'s clock is no longer ${toStateSince} — the evidence moved.`);
    }
    const watermark = roadBonusWeeksNotified != null
      ? Number(roadBonusWeeksNotified)
      : Math.max(Number(target.road_bonus_weeks_notified) || 0, Number(source.road_bonus_weeks_notified) || 0);

    await client.query(
      `UPDATE driver_home_status
          SET state_since = $2, road_bonus_weeks_notified = $3, updated_at = NOW()
        WHERE group_id = $1`,
      [groupId, toStateSince, watermark]
    );
    return {
      oldValues: { state_since: target.state_since, road_bonus_weeks_notified: target.road_bonus_weeks_notified },
      newValues: { state_since: toStateSince, road_bonus_weeks_notified: watermark },
      affectedRecords: [{ table: 'driver_home_status', groupId, carriedFromGroupId: fromGroupId }],
    };
  },

  async revert(correction, client) {
    const groupId = Number(correction.subject_id);
    const current = await client.query(
      'SELECT state_since, road_bonus_weeks_notified FROM driver_home_status WHERE group_id = $1 FOR UPDATE',
      [groupId]
    );
    if (!current.rows[0]) throw new StaleCorrectionError(`Group ${groupId} has no home-time status row.`);
    assertUnchangedSince(correction.new_values, current.rows[0], `Group ${groupId}'s clock`);
    await client.query(
      `UPDATE driver_home_status
          SET state_since = $2, road_bonus_weeks_notified = $3, updated_at = NOW()
        WHERE group_id = $1`,
      [groupId, correction.old_values.state_since, correction.old_values.road_bonus_weeks_notified ?? 0]
    );
  },
};

module.exports = { carryRoadClock };
