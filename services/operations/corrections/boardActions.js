/**
 * Linking a Dispatcher Board row to a person — one action, and it copies
 * nothing it has not re-derived under lock.
 *
 *   board.link_person   a board row whose truck AND name both point at one
 *                       person gets that person recorded on it.
 *
 * WHY THIS IS THE MOST CAREFUL ACTION IN THE REGISTRY. Everything else here
 * corrects a fact Wenze already holds twice. This one joins two SYSTEMS, and a
 * wrong join moves somebody's truck, their home-time clock and their bonus onto
 * another human. So:
 *
 *   - the decision is RE-RUN at apply time from the live rows, not trusted from
 *     the sweep's payload. Minutes pass between a sweep and an apply, and a
 *     person can be linked by hand in between;
 *   - it refuses unless the re-run still says `link` AND still says the SAME
 *     person. "Still linkable" is not good enough — linkable to somebody else
 *     is the exact case worth refusing;
 *   - the revert clears the link only while it still holds what this correction
 *     set. A link somebody has since changed by hand is theirs, not ours.
 */
const { decideBoardLink } = require('../../../lib/identity/boardResolution');
const { holdersFor, indexLayer } = require('../checks/boardLink');
const { StaleCorrectionError } = require('./evidence');

/**
 * Re-read exactly what the check read, for ONE row, under lock.
 *
 * The check works from a sweep-wide snapshot; this rebuilds the same two
 * inputs for a single row straight from the database, so the rule sees the
 * world as it is now rather than as it was when the finding was filed.
 */
async function liveDecisionFor(rowKey, client) {
  const rowRes = await client.query(
    `SELECT id, row_key, driver_name_clean, fleet_type, truck_norm, truck_digits,
            is_team, team_members, person_id, present
       FROM dispatch_board_rows WHERE row_key = $1 FOR UPDATE`,
    [rowKey]
  );
  const raw = rowRes.rows[0];
  if (!raw) throw new StaleCorrectionError(`Board row ${rowKey} no longer exists.`);
  if (raw.present !== true) {
    throw new StaleCorrectionError(`Board row ${rowKey} is no longer on the board.`);
  }

  const row = {
    rowKey: raw.row_key,
    cleanName: raw.driver_name_clean,
    fleetType: raw.fleet_type,
    truckNorm: raw.truck_norm,
    truckDigits: raw.truck_digits,
    isTeam: raw.is_team === true,
    teamMembers: raw.team_members || [],
    personId: raw.person_id,
  };

  // THE HOLDERS ARE LOCKED TOO. They are the evidence, and an unlocked read
  // would let a concurrent sync move the truck out from under this decision
  // between the re-derivation and the write.
  const [people, units] = await Promise.all([
    client.query('SELECT id, display_name, merged_into_person_id FROM driver_people'),
    client.query(
      `SELECT person_id, unit_number, fleet_type, seat FROM driver_units
        WHERE ended_at IS NULL FOR UPDATE`
    ),
  ]);
  const index = indexLayer({ people: people.rows, units: units.rows });
  const nameCandidates = [...index.nameOf.entries()].map(([personId, displayName]) => ({
    personId, displayName, fleetType: null,
  }));

  return {
    raw,
    row,
    decision: decideBoardLink({ row, unitHolders: holdersFor(row, index), nameCandidates }),
  };
}

const linkBoardRowToPerson = {
  key: 'board.link_person',
  tier: 'auto',
  subjectType: 'board_row',
  describe: (p) => `Record the board row for ${p.rowKey} as person ${p.personId}`,

  async apply({ rowKey, personId, linkSource = 'board' }, client) {
    if (!rowKey || !personId) throw new StaleCorrectionError('A row and a person are both required.');
    const { raw, decision } = await liveDecisionFor(rowKey, client);

    if (raw.person_id != null) {
      throw new StaleCorrectionError(`Board row ${rowKey} is already linked to person ${raw.person_id}.`);
    }
    // STILL LINKABLE IS NOT ENOUGH — it must still be linkable to THIS person.
    if (decision.action !== 'link') {
      throw new StaleCorrectionError(
        `Board row ${rowKey} no longer resolves to one person (${decision.reason}).`
      );
    }
    if (Number(decision.personId) !== Number(personId)) {
      throw new StaleCorrectionError(
        `Board row ${rowKey} now resolves to person ${decision.personId}, not ${personId}.`
      );
    }

    const updated = await client.query(
      `UPDATE dispatch_board_rows
          SET person_id = $2, link_source = $3, link_confidence = $4
        WHERE row_key = $1 AND person_id IS NULL
        RETURNING id, person_id`,
      [rowKey, Number(personId), linkSource, decision.confidence]
    );
    if (updated.rowCount === 0) {
      throw new StaleCorrectionError(`Board row ${rowKey} was linked by somebody else first.`);
    }

    return {
      oldValues: { personId: null, linkSource: null, linkConfidence: null },
      newValues: {
        personId: Number(personId), linkSource, linkConfidence: decision.confidence, rowKey,
      },
      affectedRecords: [{ table: 'dispatch_board_rows', id: updated.rows[0].id, rowKey }],
    };
  },

  /**
   * Clear the link — but only while it still holds what this correction set.
   *
   * A row somebody has since pointed at a different person is THEIR decision,
   * and a revert that overwrote it would undo a person's work in the name of
   * undoing ours.
   */
  async revert(correction, client) {
    const rowKey = correction.new_values?.rowKey;
    const personId = correction.new_values?.personId;
    if (!rowKey) throw new StaleCorrectionError('This correction did not record which row it linked.');

    const cleared = await client.query(
      `UPDATE dispatch_board_rows
          SET person_id = NULL, link_source = NULL, link_confidence = NULL
        WHERE row_key = $1 AND person_id = $2
        RETURNING id`,
      [rowKey, Number(personId)]
    );
    if (cleared.rowCount === 0) {
      throw new StaleCorrectionError(
        `Board row ${rowKey} is no longer linked to person ${personId} — leaving it alone.`
      );
    }
  },
};

module.exports = { linkBoardRowToPerson, liveDecisionFor };
