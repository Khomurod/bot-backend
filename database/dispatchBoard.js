'use strict';

/**
 * The Dispatcher Board snapshot — what the Board said, as Wenze last read it.
 *
 * Not a second driver table. Every row is one line of somebody else's
 * spreadsheet, kept so a disagreement between the Board and Wenze can be shown
 * rather than guessed at.
 *
 * TWO RULES THIS MODULE EXISTS TO KEEP:
 *
 *   A ROW IS NEVER DELETED. One that stops appearing is marked absent.
 *   "This driver left the board on Tuesday" is a fact somebody will want, and a
 *   DELETE is the one edit nobody can review afterwards.
 *
 *   `last_changed_at` MOVES ONLY ON A REAL CHANGE. The poller writes every row
 *   every few minutes; if the timestamp moved each time it would answer "when
 *   did we last read this" instead of "when did something happen to this
 *   driver", and only the second question is worth asking.
 */
const { query, pool } = require('./pool');

/** The fields whose change is worth a `last_changed_at`. */
const MEANINGFUL_COLUMNS = Object.freeze([
  'driver_name_raw', 'fleet_type', 'is_team', 'truck_norm',
  'board_trailer', 'phone', 'status', 'eta_text', 'origin_delivery',
  'notes', 'dispatcher',
]);

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    rowKey: row.row_key,
    sheetRow: row.sheet_row,
    driverNameRaw: row.driver_name_raw,
    cleanName: row.driver_name_clean,
    fleetType: row.fleet_type,
    fleetLabelRaw: row.fleet_label_raw,
    fleetLabelNormalised: row.fleet_label_normalised === true,
    isTeam: row.is_team === true,
    teamMembers: row.team_members || [],
    teamFlagMismatch: row.team_flag_mismatch === true,
    truckRaw: row.truck_raw,
    truckNorm: row.truck_norm,
    truckDigits: row.truck_digits,
    boardTrailer: row.board_trailer,
    phone: row.phone,
    status: row.status,
    statusRaw: row.status_raw,
    etaText: row.eta_text,
    originDelivery: row.origin_delivery,
    notes: row.notes,
    dispatcher: row.dispatcher,
    lastUpdatedBy: row.last_updated_by,
    keyCollision: row.key_collision === true,
    present: row.present === true,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastChangedAt: row.last_changed_at,
    personId: row.person_id,
    linkSource: row.link_source,
    linkConfidence: row.link_confidence,
  };
}

/**
 * Write one pass of the Board.
 *
 * Every row is upserted by `row_key`. A row that comes back with the same
 * meaningful fields keeps its `last_changed_at`; one that differs moves it.
 * A row that reappears after vanishing becomes present again rather than a
 * second row — the same driver on the same truck is the same line.
 *
 * @param {object[]} rows  parsed rows (lib/board/parse.js)
 * @returns {Promise<{inserted:number, updated:number, unchanged:number}>}
 */
async function upsertBoardRows(rows, client = null) {
  const run = client ? client.query.bind(client) : query;
  const counts = { inserted: 0, updated: 0, unchanged: 0, skipped: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    // `driver_name_raw` is NOT NULL, and the tolerant parser keeps a row with a
    // truck and a blank driver cell. Inserting it raises a constraint error, and
    // because one spreadsheet cell caused it the SAME pass fails every few
    // minutes and no later row is ever refreshed. A row that names nobody is
    // not an assignment; it is skipped and counted.
    if (!row?.rowKey || !row.driverNameRaw) { counts.skipped += 1; continue; }
    const changed = MEANINGFUL_COLUMNS
      .map((c) => `dispatch_board_rows.${c} IS DISTINCT FROM EXCLUDED.${c}`)
      .join(' OR ');
    // eslint-disable-next-line no-await-in-loop
    const res = await run(
      `INSERT INTO dispatch_board_rows (
         row_key, sheet_row, driver_name_raw, driver_name_clean, fleet_type,
         fleet_label_raw, fleet_label_normalised, is_team, team_members,
         team_flag_mismatch, truck_raw, truck_norm, truck_digits, board_trailer,
         phone, status, status_raw, eta_text, origin_delivery, notes,
         dispatcher, last_updated_by, key_collision, present
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, TRUE)
       ON CONFLICT (row_key) DO UPDATE SET
         sheet_row = EXCLUDED.sheet_row,
         driver_name_raw = EXCLUDED.driver_name_raw,
         driver_name_clean = EXCLUDED.driver_name_clean,
         fleet_type = EXCLUDED.fleet_type,
         fleet_label_raw = EXCLUDED.fleet_label_raw,
         fleet_label_normalised = EXCLUDED.fleet_label_normalised,
         is_team = EXCLUDED.is_team,
         team_members = EXCLUDED.team_members,
         team_flag_mismatch = EXCLUDED.team_flag_mismatch,
         truck_raw = EXCLUDED.truck_raw,
         truck_norm = EXCLUDED.truck_norm,
         truck_digits = EXCLUDED.truck_digits,
         board_trailer = EXCLUDED.board_trailer,
         phone = EXCLUDED.phone,
         status = EXCLUDED.status,
         status_raw = EXCLUDED.status_raw,
         eta_text = EXCLUDED.eta_text,
         origin_delivery = EXCLUDED.origin_delivery,
         notes = EXCLUDED.notes,
         dispatcher = EXCLUDED.dispatcher,
         last_updated_by = EXCLUDED.last_updated_by,
         key_collision = EXCLUDED.key_collision,
         present = TRUE,
         last_seen_at = NOW(),
         last_changed_at = CASE WHEN ${changed}
           THEN NOW() ELSE dispatch_board_rows.last_changed_at END,
         updated_at = NOW()
       RETURNING (xmax = 0) AS inserted,
                 (last_changed_at = updated_at) AS touched`,
      [
        row.rowKey, row.sheetRow ?? null, row.driverNameRaw, row.cleanName ?? null,
        row.fleetType || 'unknown', row.fleetLabelRaw ?? null,
        row.fleetLabelNormalised === true, row.isTeam === true,
        Array.isArray(row.teamMembers) && row.teamMembers.length ? row.teamMembers : null,
        row.teamFlagMismatch === true, row.truckRaw ?? null, row.truckNorm ?? null,
        row.truckDigits ?? null, row.boardTrailer ?? null, row.phone ?? null,
        row.status || 'UNKNOWN', row.statusRaw ?? null, row.etaText ?? null,
        row.originDelivery ?? null, row.notes ?? null, row.dispatcher ?? null,
        row.lastUpdatedBy ?? null, row.rowKeyCollision === true,
      ]
    );
    const result = res.rows[0] || {};
    if (result.inserted) counts.inserted += 1;
    else if (result.touched) counts.updated += 1;
    else counts.unchanged += 1;
  }
  return counts;
}

/**
 * Mark every present row that this pass did not see as absent.
 *
 * Never a DELETE. An empty `keepKeys` marks everything absent, which is what an
 * empty board means — but the caller is expected not to call this after a pass
 * that failed, because "we could not read it" is not "nobody is on it".
 */
async function markAbsent(keepKeys, client = null) {
  const run = client ? client.query.bind(client) : query;
  const keys = Array.isArray(keepKeys) ? keepKeys.filter(Boolean) : [];
  const res = await run(
    `UPDATE dispatch_board_rows
        SET present = FALSE, last_changed_at = NOW(), updated_at = NOW()
      WHERE present = TRUE
        AND NOT (row_key = ANY($1::text[]))
      RETURNING row_key`,
    [keys.length ? keys : ['']]
  );
  return res.rowCount || 0;
}

/**
 * One pass of the Board, applied as ONE transaction.
 *
 * WHY A TRANSACTION AND NOT TWO CALLS. `query` autocommits, so a pass that
 * upserted forty rows and then failed on the forty-first left the snapshot
 * half-new: the poller reported the pass as failed, and the mixed state stayed
 * until some later pass succeeded — indefinitely, if the bad row kept coming
 * back. "A failed pass leaves the snapshot exactly as it was" has to be true of
 * a pass that failed HALFWAY, which is the only kind that matters.
 *
 * The caller decides whether a pass is fit to apply at all; this decides only
 * that it happens completely or not at all.
 *
 * @param {object[]} rows      rows to store (already judged storable)
 * @param {string[]} keepKeys  the keys that stay present; everything else is
 *   marked absent INSIDE the same transaction
 */
async function applyBoardPass(rows, keepKeys) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const counts = await upsertBoardRows(rows, client);
    const absent = await markAbsent(keepKeys, client);
    await client.query('COMMIT');
    return { ...counts, absent };
  } catch (err) {
    // A rollback that itself fails must not replace the real error with its own.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function listBoardRows({ presentOnly = true, status = null, fleetType = null, limit = 500 } = {}) {
  const res = await query(
    `SELECT * FROM dispatch_board_rows
      WHERE ($1::boolean IS FALSE OR present = TRUE)
        AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR fleet_type = $3)
      ORDER BY present DESC, driver_name_clean NULLS LAST, row_key
      LIMIT $4`,
    [presentOnly, status, fleetType, limit]
  );
  return res.rows.map(mapRow);
}

/** Counts only — safe for `/api/health` and for a settings screen. */
async function summariseBoard() {
  const res = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE present)::int AS present,
            COUNT(*) FILTER (WHERE present AND fleet_type = 'company')::int AS company,
            COUNT(*) FILTER (WHERE present AND fleet_type = 'lease')::int AS lease,
            COUNT(*) FILTER (WHERE present AND fleet_type = 'owner_operator')::int AS owner_operator,
            COUNT(*) FILTER (WHERE present AND fleet_type = 'unknown')::int AS unknown_fleet,
            COUNT(*) FILTER (WHERE present AND is_team)::int AS teams,
            COUNT(*) FILTER (WHERE present AND person_id IS NOT NULL)::int AS linked,
            MAX(last_seen_at) AS last_seen_at
       FROM dispatch_board_rows`
  );
  // A SECOND QUERY, DELIBERATELY. The board's status vocabulary is the board's,
  // not ours — it grows when dispatch invents a word — so the histogram is
  // grouped rather than enumerated as FILTER columns that would need a code
  // change every time.
  const byStatus = await query(
    `SELECT status, COUNT(*)::int AS count
       FROM dispatch_board_rows
      WHERE present
      GROUP BY status
      ORDER BY count DESC, status ASC`
  );
  const r = res.rows[0] || {};
  return {
    statuses: byStatus.rows.map((row) => ({ status: row.status, count: row.count })),
    total: r.total || 0,
    present: r.present || 0,
    fleet: {
      company: r.company || 0,
      lease: r.lease || 0,
      owner_operator: r.owner_operator || 0,
      unknown: r.unknown_fleet || 0,
    },
    teams: r.teams || 0,
    linked: r.linked || 0,
    lastSeenAt: r.last_seen_at || null,
  };
}

/**
 * Every row, present and absent alike, shaped for the consistency sweep.
 *
 * TAKES A `db` because the sweep injects one: every check must see rows read
 * from the SAME database at the same moment, and a reader that quietly used its
 * own pool binding would split a sweep across two of them. It is the one reader
 * of this table for the checks — `services/operations/snapshot/loaders.js` calls
 * it rather than repeating the column list, which had briefly drifted between
 * the two copies already.
 *
 * NAMES AND TRUCKS ONLY. No phone number: a finding's evidence is read by people
 * who do not need one, and no board check has ever needed one to do its job.
 */
async function getBoardRowsForSnapshot(db = null) {
  const run = db ? db.query.bind(db) : query;
  const res = await run(
    `SELECT row_key, driver_name_clean, fleet_type, fleet_label_raw,
            fleet_label_normalised, is_team, team_flag_mismatch, key_collision,
            truck_norm, truck_digits, status, status_raw, present, person_id,
            first_seen_at, last_seen_at
       FROM dispatch_board_rows`
  );
  return res.rows.map((row) => ({
    rowKey: row.row_key,
    cleanName: row.driver_name_clean,
    fleetType: row.fleet_type,
    fleetLabelRaw: row.fleet_label_raw,
    fleetLabelNormalised: row.fleet_label_normalised === true,
    isTeam: row.is_team === true,
    teamFlagMismatch: row.team_flag_mismatch === true,
    keyCollision: row.key_collision === true,
    truckNorm: row.truck_norm,
    truckDigits: row.truck_digits,
    status: row.status,
    statusRaw: row.status_raw,
    present: row.present === true,
    personId: row.person_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }));
}

module.exports = {
  upsertBoardRows,
  markAbsent,
  applyBoardPass,
  listBoardRows,
  summariseBoard,
  getBoardRowsForSnapshot,
  MEANINGFUL_COLUMNS,
};
