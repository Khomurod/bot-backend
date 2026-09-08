/**
 * PER-RECRUITER Facebook-lead auto-SMS templates — database helpers.
 *
 * One optional row per recruiter. It overrides the global, time-based auto
 * message (facebook_lead_auto_message_settings + _rules) for leads Bitrix
 * assigned to THAT recruiter, and nothing else: there is no per-recruiter
 * schedule, no per-recruiter fallback, no second rule engine. A blank template
 * or `is_enabled = FALSE` means exactly what no row means — use the global
 * system — so clearing a textarea in the admin panel is a complete "undo".
 *
 * The listing is driven by `recruiters`, not by this table, so a recruiter
 * added later shows up with an empty template automatically.
 *
 * Split out of database/facebookLeads.js, which re-exports every symbol here.
 */
const { pool, query } = require('../pool');

/**
 * Every recruiter (active first) with their template, whether or not they have
 * a row here. `active` is included so the admin UI can show the current team
 * without hiding a template belonging to someone recently deactivated.
 *
 * @param {{includeInactive?: boolean}} [options]
 */
async function listFacebookLeadRecruiterMessages({ includeInactive = false } = {}) {
  const res = await query(
    `SELECT r.id                AS recruiter_id,
            r.name              AS recruiter_name,
            r.active            AS recruiter_active,
            r.bitrix_user_id    AS bitrix_user_id,
            m.message_template,
            COALESCE(m.is_enabled, TRUE) AS is_enabled,
            m.updated_at
       FROM recruiters r
       LEFT JOIN facebook_lead_recruiter_messages m ON m.recruiter_id = r.id
      ${includeInactive ? '' : 'WHERE r.active = TRUE'}
      ORDER BY r.active DESC, r.name ASC`
  );
  return res.rows;
}

/**
 * The template for ONE recruiter, or null when they have none / it is blank /
 * it is parked. Callers treat null as "fall back to the global message", so
 * every "no override" case collapses to the same answer here.
 */
async function getFacebookLeadRecruiterMessage(recruiterId) {
  const id = Number(recruiterId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const res = await query(
    `SELECT recruiter_id, message_template, is_enabled, updated_at
       FROM facebook_lead_recruiter_messages
      WHERE recruiter_id = $1`,
    [id]
  );
  const row = res.rows[0];
  if (!row) return null;
  if (row.is_enabled === false) return null;
  if (!String(row.message_template || '').trim()) return null;
  return row;
}

/**
 * Save the admin panel's recruiter section in one transaction.
 *
 * A blank template DELETES the row rather than storing an empty string: "no
 * custom message" has exactly one representation in the table, so nothing has
 * to remember that '' and NULL and a missing row mean the same thing.
 *
 * @param {Array<{recruiter_id:number, message_template?:string, is_enabled?:boolean}>} entries
 * @param {{updatedBy?: string|null}} [options]
 */
async function replaceFacebookLeadRecruiterMessages(entries, { updatedBy = null } = {}) {
  const rows = Array.isArray(entries) ? entries : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const entry of rows) {
      const recruiterId = Number(entry?.recruiter_id);
      if (!Number.isFinite(recruiterId) || recruiterId <= 0) continue;

      const template = String(entry?.message_template || '').trim();
      if (!template) {
        await client.query(
          'DELETE FROM facebook_lead_recruiter_messages WHERE recruiter_id = $1',
          [recruiterId]
        );
        continue;
      }

      await client.query(
        `INSERT INTO facebook_lead_recruiter_messages
           (recruiter_id, message_template, is_enabled, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (recruiter_id) DO UPDATE
            SET message_template = EXCLUDED.message_template,
                is_enabled = EXCLUDED.is_enabled,
                updated_by = EXCLUDED.updated_by,
                updated_at = NOW()`,
        [recruiterId, template, entry?.is_enabled !== false, updatedBy]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return listFacebookLeadRecruiterMessages();
}

module.exports = {
  listFacebookLeadRecruiterMessages,
  getFacebookLeadRecruiterMessage,
  replaceFacebookLeadRecruiterMessages,
};
