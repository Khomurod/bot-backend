/**
 * What the Groups page needs BESIDE each chat — the board, and the questions.
 *
 * Kept out of `services/driverGroupDirectoryService.js` because that module is
 * a pure projection over one query and this is two more queries against two
 * other features. Folding them in would make a screen that is mostly about
 * chats depend on the board and the findings engine to load at all.
 *
 * BOTH READS FAIL SOFT, and that is the point: a Groups page that will not open
 * because the dispatcher board table is missing on a half-finished deploy is a
 * worse outcome than a Groups page with no board badges.
 */
const { query } = require('./pool');

/** Which open findings are about a group, keyed by group id. */
const IDENTITY_PREFIXES = ['identity.', 'board.', 'home_time.'];

/**
 * The checks whose open findings mean "somebody still has to decide about this
 * chat". Deliberately a PREFIX list rather than every key: a new identity or
 * board check should put its group on the Needs Review tab the day it ships,
 * without a second list to remember.
 */
async function openFindingKeysByGroup() {
  try {
    const res = await query(
      `SELECT subject_id, check_key
         FROM operational_findings
        WHERE status = 'open'
          AND subject_type = 'group'
          AND (snoozed_until IS NULL OR snoozed_until <= NOW())
          AND (${IDENTITY_PREFIXES.map((_, i) => `check_key LIKE $${i + 1}`).join(' OR ')})`,
      IDENTITY_PREFIXES.map((p) => `${p}%`)
    );
    const out = new Map();
    for (const row of res.rows) {
      const id = Number(row.subject_id);
      if (!Number.isFinite(id)) continue;
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(row.check_key);
    }
    return out;
  } catch (_) {
    return new Map();
  }
}

/**
 * What the board says about each person, keyed by person id.
 *
 * INCLUDES ABSENT ROWS, unlike `driverContext.readBoard`. The two answer
 * different questions: that one asks "is the board evidence about where this
 * driver is right now", where a vanished row is not; this one asks "what does
 * the screen show beside this driver", and "no longer on the dispatcher board"
 * is exactly what somebody looking at the Groups page wants to see.
 */
async function boardByPerson() {
  try {
    const res = await query(
      `SELECT DISTINCT ON (person_id)
              person_id, status, truck_norm, present, last_seen_at
         FROM dispatch_board_rows
        WHERE person_id IS NOT NULL
        ORDER BY person_id, present DESC, last_seen_at DESC`
    );
    return new Map(res.rows.map((r) => [Number(r.person_id), {
      status: r.status,
      truck: r.truck_norm,
      present: r.present === true,
      lastSeenAt: r.last_seen_at,
    }]));
  } catch (_) {
    return new Map();
  }
}

/**
 * Decorate directory rows in place-free fashion — a new array, same order.
 *
 * NO PHONE NUMBER and no ETA text: this screen is a list of chats, and the
 * board's per-driver detail belongs on the person panel where somebody opened
 * it deliberately.
 */
async function withBoardAndFindings(rows) {
  const [findings, board] = await Promise.all([openFindingKeysByGroup(), boardByPerson()]);
  return (rows || []).map((row) => ({
    ...row,
    open_finding_keys: findings.get(Number(row.group_id)) || [],
    board: row.person_id != null ? board.get(Number(row.person_id)) || null : null,
  }));
}

module.exports = { withBoardAndFindings, openFindingKeysByGroup, boardByPerson };
