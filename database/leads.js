/**
 * Leads (Facebook + Indeed) for the admin Leads tab.
 * Extracted verbatim from database/db.js; db.js re-exports these.
 */
const { query } = require('./pool');

// ─── Leads (Facebook + Indeed) ───

/**
 * Insert a lead, deduping on (source, external_id). Returns the new row, or
 * null when a lead with the same source+external_id already exists.
 */
async function createLeadIfNew({
  source,
  externalId,
  fullName = null,
  email = null,
  phone = null,
  jobTitle = null,
  message = null,
  raw = null,
}) {
  const res = await query(
    `INSERT INTO leads (source, external_id, full_name, email, phone, job_title, message, raw, bitrix_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending')
     ON CONFLICT (source, external_id) DO NOTHING
     RETURNING *`,
    [
      source,
      externalId || null,
      fullName,
      email,
      phone,
      jobTitle,
      message,
      raw ? JSON.stringify(raw) : null,
    ]
  );
  return res.rows[0] || null;
}

async function updateLeadBitrixResult(id, { bitrixId = null, status }) {
  await query(
    `UPDATE leads SET bitrix_id = $2, bitrix_status = $3 WHERE id = $1`,
    [id, bitrixId, status]
  );
}

/**
 * Who Bitrix assigned the lead to, and which number actually texted them.
 *
 * Separate from updateLeadBitrixResult() because the answer arrives LATER: the
 * record is created first, a distribution rule assigns it, and only then is the
 * sender known. Best-effort — the Leads tab showing this is never worth failing
 * a lead over.
 */
async function updateLeadSmsSender(id, { assignedById = null, fromNumber = null, recruiterId = null }) {
  await query(
    `UPDATE leads
        SET bitrix_assigned_by_id = COALESCE($2, bitrix_assigned_by_id),
            sms_from_number = COALESCE($3, sms_from_number),
            sms_sender_recruiter_id = COALESCE($4, sms_sender_recruiter_id)
      WHERE id = $1`,
    [id, assignedById, fromNumber, recruiterId]
  );
}

async function listLeads(limit = 100, source = null) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  if (source) {
    const res = await query(
      `SELECT * FROM leads WHERE source = $1 ORDER BY created_at DESC LIMIT $2`,
      [source, safeLimit]
    );
    return res.rows;
  }
  const res = await query(
    `SELECT * FROM leads ORDER BY created_at DESC LIMIT $1`,
    [safeLimit]
  );
  return res.rows;
}


module.exports = {
  createLeadIfNew,
  updateLeadBitrixResult,
  updateLeadSmsSender,
  listLeads,
};
