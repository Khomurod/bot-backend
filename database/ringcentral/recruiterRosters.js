'use strict';

/**
 * The recruiter lists that BACKGROUND PASSES read — each asking only for what
 * its caller uses.
 *
 *   listRecruitersWithOwnCredentials  the daily token refresh: whole rows (it
 *                                     reads credentials, identity and errors)
 *   listRecruiterSmsExtensions        the leads worker's 15-minute check: id,
 *                                     name and extension — the same recruiters
 *   listRecruitersForCallSync         the 10-minute call sync: seven columns,
 *                                     re-read only when they change
 *
 * October 2026, when the hosted database's monthly transfer allowance was
 * nearly spent: the extension check and the call sync each read `SELECT *`
 * from `recruiters`, about 1.3 KB of encrypted tokens per row, to use a few
 * columns — 96 and 144 times a day.
 *
 * THE CALL-SYNC ROSTER IS KEPT, AND CHECKED EVERY PASS. A rotated OAuth refresh
 * token is single-use: a pass that refreshed with a token another caller had
 * already rotated would get `invalid_grant` and flag a healthy recruiter as
 * needing to sign in again (docs/architecture/recruiter-sms-sender.md). So the
 * kept rows are never trusted on a timer or on invalidation hooks alone.
 * Every pass first asks the database for an md5 of exactly the columns it is
 * about to use, over exactly the rows (one 32-character value). It re-reads the
 * rows when that hash differs from the one they were read under. Any change to
 * those columns is covered by construction. That includes a token rotated by
 * the lead sender or the daily job, an admin save, a deactivation, and a write
 * by another instance during a deploy. A pass therefore never uses a credential
 * older than the database's at the start of that pass, which is exactly what
 * reading every row every pass gave. A change to a column the sync never reads
 * (`rc_auth_error`, the extension identity) costs nothing.
 *
 * The hash is read BEFORE the rows, so a write landing between the two leaves
 * newer rows under an older hash, and the next pass re-reads: never the
 * reverse. Callers get copies; the kept rows cannot be edited through them.
 * The memory is owned here.
 *
 * Split from ./recruiters.js, which keeps the single-row reads and the writers.
 */
const { query } = require('../pool');

/** What the call sync reads from a recruiter row: its attribution and its credentials. */
const CALL_SYNC_COLUMNS = [
  'id', 'name', 'phone_number_normalized',
  'jwt_token_encrypted', 'client_id_encrypted', 'client_secret_encrypted', 'refresh_token_encrypted',
];
const CALL_SYNC_SELECT = CALL_SYNC_COLUMNS.join(', ');

const OWN_CREDENTIALS = `active = TRUE
        AND (refresh_token_encrypted IS NOT NULL OR jwt_token_encrypted IS NOT NULL)`;

/** { fingerprint, rows } as last read, or null. */
let callSyncRoster = null;

/**
 * Active recruiters holding their own credentials — the rows the token-refresh
 * job and the per-extension inbound-SMS subscription both work from.
 */
async function listRecruitersWithOwnCredentials() {
  const res = await query(
    `SELECT * FROM recruiters
      WHERE ${OWN_CREDENTIALS}
      ORDER BY name ASC`
  );
  return res.rows;
}

/**
 * The same recruiters as listRecruitersWithOwnCredentials(), in the same
 * order, as { id, name, rc_extension_id }: what the inbound-SMS extension list
 * uses (the id names a recruiter who has no name).
 */
async function listRecruiterSmsExtensions() {
  const res = await query(
    `SELECT id, name, rc_extension_id FROM recruiters
      WHERE ${OWN_CREDENTIALS}
      ORDER BY name ASC`
  );
  return res.rows;
}

/**
 * Active recruiters, by name, with only CALL_SYNC_COLUMNS: what one call-sync
 * pass needs to resolve each recruiter's credentials and attribute calls.
 * One small statement when nothing changed; that plus the rows when it did.
 */
async function listRecruitersForCallSync() {
  const check = await query(
    `SELECT md5(COALESCE(json_agg(json_build_array(${CALL_SYNC_SELECT}) ORDER BY id)::text, '')) AS fingerprint
       FROM recruiters
      WHERE active = TRUE`
  );
  const fingerprint = check.rows[0]?.fingerprint || null;
  if (!callSyncRoster || !fingerprint || callSyncRoster.fingerprint !== fingerprint) {
    const res = await query(
      `SELECT ${CALL_SYNC_SELECT}
         FROM recruiters
        WHERE active = TRUE
        ORDER BY name ASC`
    );
    callSyncRoster = fingerprint ? { fingerprint, rows: res.rows } : null;
    return res.rows.map((row) => ({ ...row }));
  }
  return callSyncRoster.rows.map((row) => ({ ...row }));
}

module.exports = {
  listRecruitersWithOwnCredentials,
  listRecruiterSmsExtensions,
  listRecruitersForCallSync,
};
