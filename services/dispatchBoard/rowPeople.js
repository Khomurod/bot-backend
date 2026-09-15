'use strict';

/**
 * Which PERSON each Dispatcher Board row is about.
 *
 * ONE MATCHER, TWO READERS. The raise roster rebuild and the home-time watch
 * both need this answer, and the worst possible outcome is two slightly
 * different rules: a driver who is Charles's on one screen and Steven's on
 * another, or home in one feature and on the road in the next. So the rule lives
 * here once, and it is not a new rule — it is `lib/identity/boardResolution.js`,
 * the same pure decision the board-link check files findings from.
 *
 * IT REFUSES MORE OFTEN THAN IT ANSWERS, and that is the design. Only a row the
 * rule settles (`link`, or a link somebody already made) is returned. A
 * digits-only truck match, a name that fits two people, a row whose linked
 * person no longer holds the truck — all of them come back unresolved, and the
 * caller leaves the driver out rather than acting on a plausible guess.
 *
 * TWO ROWS ABOUT ONE PERSON DISQUALIFY BOTH. A row left behind by a move means
 * the board is saying two things about one human; picking one would be a coin
 * toss against operational state.
 *
 * A TEAM ROW IS TWO PEOPLE, AND BOTH OF THEM COUNT. One board line reading
 * "A / B" on truck 310 is two drivers, each with their own dispatch team and
 * their own home-time cycle. Handing the combined name to the single-person
 * resolver asks an unanswerable question — two holders on one truck read as
 * ambiguous — and the answer "nobody" would quietly drop both of them off
 * every roster. `decideTeamBoardLink` asks about each member separately, and
 * still refuses BOTH when the two names resolve to one stored person, because
 * that is a composite row somebody has to split by hand.
 *
 * Plain SELECTs rather than the data-layer helpers, for the same reason
 * `services/operations/snapshot/loaders.js` uses them: several of those helpers
 * seed rows on read, and asking who somebody is must never create them.
 */

const { decideBoardLink, decideTeamBoardLink } = require('../../lib/identity/boardResolution');
const { indexLayer, holdersFor } = require('../operations/checks/boardLink');

/** The person layer, in the shape `decideBoardLink` reads. */
async function loadPersonLayer(db) {
  const [people, units] = await Promise.all([
    db.query('SELECT id, display_name, merged_into_person_id FROM driver_people'),
    db.query('SELECT person_id, unit_number, fleet_type, seat FROM driver_units WHERE ended_at IS NULL'),
  ]);
  return { people: people.rows, units: units.rows };
}

/**
 * @param {Array} rows   board rows (database/dispatchBoard mapRow shape)
 * @param {object} layer `{ people, units }` from `loadPersonLayer`
 * @returns `{ byPerson: Map<'person:<id>', row-ish>, unresolved: [] }`
 */
function resolveBoardRowsToPeople(rows, layer) {
  const index = indexLayer(layer);
  const nameCandidates = [...index.nameOf.entries()].map(([personId, displayName]) => ({
    personId, displayName, fleetType: null,
  }));
  const byPerson = new Map();
  const unresolved = [];

  /** A settled decision joins the map; a second one about the same person voids both. */
  const place = (row, decision, name = null) => {
    const settled = decision.action === 'link'
      || (decision.action === 'none' && decision.personId != null);
    if (!settled || decision.personId == null) {
      unresolved.push({
        row, name,
        reason: decision.reason || 'the board row could not be matched to a person',
      });
      return;
    }
    const key = `person:${decision.personId}`;
    if (byPerson.has(key)) {
      byPerson.set(key, { duplicate: true, personId: decision.personId, rowKey: row.rowKey, row: null });
      return;
    }
    byPerson.set(key, {
      personId: decision.personId,
      name: name || row.cleanName || null,
      rowKey: row.rowKey,
      dispatcher: row.dispatcher,
      status: row.status,
      statusChangedAt: row.statusChangedAt,
      lastSeenAt: row.lastSeenAt,
      row,
    });
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.present) continue;
    const unitHolders = holdersFor(row, index);

    if (row.isTeam && Array.isArray(row.teamMembers) && row.teamMembers.length > 1) {
      const { members } = decideTeamBoardLink({
        row, members: row.teamMembers, lookupFor: () => ({ unitHolders, nameCandidates }),
      });
      for (const member of members) place(row, member, member.name);
      continue;
    }

    place(row, decideBoardLink({ row, unitHolders, nameCandidates }));
  }
  return { byPerson, unresolved };
}

module.exports = { loadPersonLayer, resolveBoardRowsToPeople };
