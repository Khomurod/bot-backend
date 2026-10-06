/**
 * Releasing a held road bonus — an APPROVAL action, only ever applied by a
 * person.
 *
 *   home_time.release_road_bonus   a leg held because the trip was longer than
 *                                  six weeks moves from `needs_review` to
 *                                  `released`; the road-bonus poller then posts
 *                                  its summary.
 *
 * It changes what is paid, so it is never `auto`. It refuses anything that is
 * not still held and unposted — a leg somebody already released, or one whose
 * summary already went out, is a settled question.
 */
const { StaleCorrectionError } = require('./evidence');

const releaseRoadBonus = {
  key: 'home_time.release_road_bonus',
  tier: 'approval',
  subjectType: 'road_history',
  describe: (p) => `Release the held road bonus on trip ${p.roadHistoryId}`,

  async apply({ roadHistoryId }, client) {
    if (!roadHistoryId) throw new StaleCorrectionError('A road trip is required.');
    const res = await client.query(
      `SELECT id, bonus_decision, bonus_posted_at, bonus_usd
         FROM driver_road_history WHERE id = $1 FOR UPDATE`,
      [roadHistoryId]
    );
    const leg = res.rows[0];
    if (!leg) throw new StaleCorrectionError(`Road trip ${roadHistoryId} no longer exists.`);
    if (leg.bonus_decision !== 'needs_review' || leg.bonus_posted_at) {
      throw new StaleCorrectionError(`Road trip ${roadHistoryId}'s bonus is no longer held.`);
    }
    await client.query(
      `UPDATE driver_road_history
          SET bonus_decision = 'released', bonus_decided_at = NOW()
        WHERE id = $1`,
      [roadHistoryId]
    );
    return {
      oldValues: { bonus_decision: 'needs_review' },
      newValues: { bonus_decision: 'released', roadHistoryId: Number(roadHistoryId) },
      affectedRecords: [{ table: 'driver_road_history', id: Number(roadHistoryId) }],
    };
  },

  /** Back to held — but only while the summary has not been posted. */
  async revert(correction, client) {
    const id = Number(correction.new_values?.roadHistoryId || correction.subject_id);
    const res = await client.query(
      `UPDATE driver_road_history
          SET bonus_decision = 'needs_review', bonus_decided_at = NOW()
        WHERE id = $1 AND bonus_decision = 'released' AND bonus_posted_at IS NULL
        RETURNING id`,
      [id]
    );
    if (res.rowCount === 0) {
      throw new StaleCorrectionError(
        `Road trip ${id}'s bonus summary has already been posted, or it is no longer released — leaving it alone.`
      );
    }
  },
};

module.exports = { releaseRoadBonus };
