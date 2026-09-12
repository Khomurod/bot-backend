/**
 * The reads and bulk stamps the identity RESOLVER needs — the questions
 * `people.js` and `associations.js` do not answer because they are about one
 * row at a time.
 *
 *   "Which person does this Telegram account already belong to?"
 *   "Which people with this name have no active chat any more?"
 *   "Stamp everything this group has recorded onto its person."
 *
 * Every stamp is `WHERE person_id IS NULL`: a row that already names a person
 * is history, and history is not rewritten when a chat changes hands.
 */
const { query } = require('../pool');

/** Group-keyed tables that carry a `person_id` (migration 0026). */
const GROUP_KEYED_TABLES = [
  'driver_road_history', 'driver_home_status', 'home_time_requests',
  'fuel_stop_alerts', 'route_assignments', 'dispatch_team_drivers',
];

/**
 * The canonical person of some OTHER active group whose profile carries this
 * Telegram user id. One human texting from two chats is the hard anchor.
 */
async function findPersonByTelegramUserId(telegramUserId, { excludeGroupId = null } = {}, client = null) {
  const run = client ? client.query.bind(client) : query;
  if (telegramUserId == null || telegramUserId === '') return null;
  const res = await run(
    `SELECT COALESCE(p.merged_into_person_id, p.id) AS person_id
       FROM driver_profiles dp
       JOIN driver_person_groups pg ON pg.group_id = dp.group_id AND pg.ended_at IS NULL
       JOIN driver_people p ON p.id = pg.person_id
      WHERE dp.telegram_user_id = $1
        AND ($2::int IS NULL OR dp.group_id <> $2)
      ORDER BY pg.started_at DESC
      LIMIT 1`,
    [String(telegramUserId), excludeGroupId]
  );
  return res.rows[0] ? Number(res.rows[0].person_id) : null;
}

/**
 * Canonical people with this normalized name whose open associations are all
 * to INACTIVE groups (or who have none) — the "returning driver" shape.
 * A person still on an active chat is excluded: that is a namesake, not a return.
 */
async function findReturningCandidates(normalizedKey, { excludeGroupId = null } = {}, client = null) {
  const run = client ? client.query.bind(client) : query;
  if (!normalizedKey) return [];
  const res = await run(
    `SELECT p.id AS person_id,
            COALESCE(array_agg(pg.group_id) FILTER (WHERE pg.group_id IS NOT NULL), '{}') AS open_group_ids,
            BOOL_OR(g.active = TRUE AND g.id IS DISTINCT FROM $2) AS on_active_group
       FROM driver_people p
       LEFT JOIN driver_person_groups pg ON pg.person_id = p.id AND pg.ended_at IS NULL
       LEFT JOIN groups g ON g.id = pg.group_id
      WHERE p.normalized_key = $1 AND p.merged_into_person_id IS NULL
      GROUP BY p.id
     HAVING COALESCE(BOOL_OR(g.active = TRUE AND g.id IS DISTINCT FROM $2), FALSE) = FALSE
      ORDER BY p.id`,
    [normalizedKey, excludeGroupId]
  );
  return res.rows.map((row) => ({
    personId: Number(row.person_id),
    openGroupIds: (row.open_group_ids || []).map(Number),
  }));
}

/** The column that identifies a row for a later, exact revert. */
function rowKeyOf(table) {
  return table === 'driver_home_status' ? 'group_id' : 'id';
}

/**
 * Stamp every unstamped row this group has recorded onto `personId`.
 *
 * Returns the EXACT rows it changed, per table, because a correction that
 * stamps must be able to lift precisely those and nothing else — a row that
 * already named the person, or one stamped later by an insert, is not this
 * write's to undo.
 *
 * @returns {Promise<Record<string, {count:number, ids:Array}>>}
 */
async function stampPersonIdForGroup(groupId, personId, client = null) {
  const run = client ? client.query.bind(client) : query;
  const touched = {};
  for (const table of GROUP_KEYED_TABLES) {
    const key = rowKeyOf(table);
    const res = await run(
      `UPDATE ${table} SET person_id = $2 WHERE group_id = $1 AND person_id IS NULL RETURNING ${key}`,
      [groupId, personId]
    );
    touched[table] = { count: res.rowCount || 0, ids: res.rows.map((r) => r[key]) };
  }
  return touched;
}

/**
 * Lift the stamps a `stampPersonIdForGroup` call wrote — those rows only, and
 * only while they still carry that person.
 */
async function unstampRows(stamped, personId, client = null) {
  const run = client ? client.query.bind(client) : query;
  const lifted = {};
  for (const table of GROUP_KEYED_TABLES) {
    const ids = (stamped?.[table]?.ids || []).map(Number).filter(Number.isInteger);
    if (!ids.length) { lifted[table] = 0; continue; }
    const res = await run(
      `UPDATE ${table} SET person_id = NULL WHERE ${rowKeyOf(table)} = ANY($1::int[]) AND person_id = $2`,
      [ids, personId]
    );
    lifted[table] = res.rowCount || 0;
  }
  return lifted;
}

/**
 * Move a group's rows from one person to another — the reconcile case, where a
 * chat was first given its own person and a Telegram id later proved it was
 * somebody already on record. Only rows stamped with the superseded person move.
 */
async function restampPersonIdForGroup(groupId, fromPersonId, toPersonId, client = null) {
  const run = client ? client.query.bind(client) : query;
  const touched = {};
  for (const table of GROUP_KEYED_TABLES) {
    const res = await run(
      `UPDATE ${table} SET person_id = $3 WHERE group_id = $1 AND person_id = $2`,
      [groupId, fromPersonId, toPersonId]
    );
    touched[table] = res.rowCount || 0;
  }
  return touched;
}

/**
 * The one-off fill for rows that predate stamping — the same statements as
 * migration 0026's tail, callable from the admin after a backfill so production
 * populates without shell access. Idempotent: every UPDATE is IS NULL-guarded.
 */
async function stampAllFromAssociations(client = null) {
  const run = client ? client.query.bind(client) : query;
  const touched = {};
  for (const table of GROUP_KEYED_TABLES) {
    const res = await run(
      `UPDATE ${table} t SET person_id = pg.person_id
         FROM driver_person_groups pg
        WHERE pg.group_id = t.group_id AND pg.ended_at IS NULL AND t.person_id IS NULL`
    );
    touched[table] = res.rowCount || 0;
  }
  const mileage = await run(
    `UPDATE mileage_bonus_progress m SET person_id = k.person_id
       FROM (
         SELECT regexp_replace(btrim(upper(regexp_replace(display_name, '[^A-Za-z0-9 ]+', ' ', 'g'))), '\\s+', ' ', 'g') AS name_key,
                MIN(id) AS person_id
           FROM driver_people WHERE merged_into_person_id IS NULL
          GROUP BY 1 HAVING COUNT(*) = 1
       ) k
      WHERE k.name_key = m.driver_normalized_name AND m.person_id IS NULL`
  );
  touched.mileage_bonus_progress = mileage.rowCount || 0;
  return touched;
}

/** Everything the admin shows about one person: the row, every chat, every truck. */
async function getPersonIdentity(personId) {
  const person = await query('SELECT * FROM driver_people WHERE id = $1', [personId]);
  if (!person.rows[0]) return null;
  const [groups, units, mergedFrom, boardRows] = await Promise.all([
    query(
      `SELECT pg.id, pg.group_id, pg.started_at, pg.ended_at, pg.association_source, pg.confidence,
              g.group_name, g.active AS group_active, g.telegram_group_id
         FROM driver_person_groups pg
         JOIN groups g ON g.id = pg.group_id
        WHERE pg.person_id = $1
        ORDER BY pg.ended_at IS NULL DESC, pg.started_at DESC, pg.id DESC`,
      [personId]
    ),
    query(
      `SELECT id, unit_number, samsara_vehicle_id, fleet_type, seat, started_at, ended_at, source
         FROM driver_units WHERE person_id = $1
        ORDER BY ended_at IS NULL DESC, started_at DESC, id DESC`,
      [personId]
    ),
    query('SELECT id, display_name FROM driver_people WHERE merged_into_person_id = $1 ORDER BY id', [personId]),
    // WHAT THE BOARD SAYS ABOUT THIS PERSON TODAY. Not authoritative about who
    // they are — that is this table's job — but it is the one place an
    // administrator can see the two systems side by side and notice they
    // disagree. Wrapped: a deploy that has not applied 0046 yet must not take
    // the person panel down with it.
    query(
      `SELECT row_key, truck_norm, board_trailer, status, eta_text, dispatcher,
              link_source, link_confidence, present, last_seen_at
         FROM dispatch_board_rows WHERE person_id = $1
        ORDER BY present DESC, last_seen_at DESC`,
      [personId]
    ).catch(() => ({ rows: [] })),
  ]);
  const row = person.rows[0];
  return {
    id: row.id,
    displayName: row.display_name,
    normalizedKey: row.normalized_key,
    dateOfBirth: row.date_of_birth,
    createdSource: row.created_source,
    createdAt: row.created_at,
    mergedIntoPersonId: row.merged_into_person_id,
    mergedFrom: mergedFrom.rows.map((r) => ({ id: r.id, displayName: r.display_name })),
    groups: groups.rows.map((r) => ({
      id: r.id,
      groupId: r.group_id,
      groupName: r.group_name,
      groupActive: r.group_active,
      telegramGroupId: r.telegram_group_id != null ? String(r.telegram_group_id) : null,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      associationSource: r.association_source,
      confidence: r.confidence,
    })),
    units: units.rows.map((r) => ({
      id: r.id,
      unitNumber: r.unit_number,
      samsaraVehicleId: r.samsara_vehicle_id,
      fleetType: r.fleet_type,
      seat: r.seat,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      source: r.source,
    })),
    // NO PHONE NUMBER. The board row carries one and this panel has no use for
    // it; publishing it here would put a driver's number on a screen that
    // exists to answer "is this the right person".
    board: boardRows.rows.map((r) => ({
      rowKey: r.row_key,
      truck: r.truck_norm,
      trailer: r.board_trailer,
      status: r.status,
      etaText: r.eta_text,
      dispatcher: r.dispatcher,
      linkSource: r.link_source,
      linkConfidence: r.link_confidence,
      present: r.present === true,
      lastSeenAt: r.last_seen_at,
    })),
  };
}

/** How populated the layer is — the numbers the Identity tab opens with. */
async function summariseIdentityCoverage() {
  const res = await query(
    `SELECT
       (SELECT COUNT(*) FROM driver_people WHERE merged_into_person_id IS NULL) AS people,
       (SELECT COUNT(*) FROM groups g WHERE g.group_type = 'driver' AND g.active = TRUE) AS active_driver_groups,
       (SELECT COUNT(*) FROM groups g WHERE g.group_type = 'driver' AND g.active = TRUE
           AND NOT EXISTS (SELECT 1 FROM driver_person_groups pg WHERE pg.group_id = g.id AND pg.ended_at IS NULL)) AS groups_without_person,
       (SELECT COUNT(*) FROM driver_units WHERE ended_at IS NULL) AS open_units,
       (SELECT COUNT(*) FROM driver_road_history WHERE person_id IS NULL) AS unstamped_road_history,
       (SELECT COUNT(*) FROM home_time_requests WHERE person_id IS NULL) AS unstamped_requests,
       (SELECT COUNT(*) FROM mileage_bonus_progress WHERE person_id IS NULL) AS unstamped_mileage`
  );
  // THE BOARD'S OWN COVERAGE, asked separately and allowed to fail. Folding it
  // into the query above would mean a deploy that has not applied 0046 takes
  // the whole Identity tab down over a table it does not need.
  const board = await query(
    `SELECT COUNT(*)::int AS present,
            COUNT(*) FILTER (WHERE person_id IS NOT NULL)::int AS linked
       FROM dispatch_board_rows WHERE present = TRUE`
  ).catch(() => ({ rows: [] }));
  const row = res.rows[0] || {};
  const n = (v) => Number(v) || 0;
  return {
    people: n(row.people),
    activeDriverGroups: n(row.active_driver_groups),
    groupsWithoutPerson: n(row.groups_without_person),
    openUnits: n(row.open_units),
    unstamped: {
      roadHistory: n(row.unstamped_road_history),
      requests: n(row.unstamped_requests),
      mileage: n(row.unstamped_mileage),
    },
    // How much of today's board Wenze can put a name to. `present` minus
    // `linked` is what is still waiting on a decision — and on a board with
    // team pairs it is never expected to reach zero, since the second member of
    // a team row is decided separately.
    board: board.rows[0]
      ? { present: n(board.rows[0].present), linked: n(board.rows[0].linked) }
      : null,
  };
}

module.exports = {
  GROUP_KEYED_TABLES,
  findPersonByTelegramUserId,
  findReturningCandidates,
  stampPersonIdForGroup,
  unstampRows,
  restampPersonIdForGroup,
  stampAllFromAssociations,
  getPersonIdentity,
  summariseIdentityCoverage,
};
