/**
 * Leads (Facebook + Indeed): the writers, and the admin Leads tab's list and
 * its fingerprint. Extracted from database/db.js, which re-exports these.
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
 * One lead by the identity Meta gave it, or null.
 *
 * Exists for the "have we already texted this person?" check.
 * `createLeadIfNew` cannot answer it: on a re-delivered or replayed event its
 * `ON CONFLICT DO NOTHING` returns null, which says "not new" but not what the
 * existing row already knows.
 */
async function getLeadBySourceExternalId(source, externalId) {
  if (!source || !externalId) return null;
  const res = await query(
    'SELECT * FROM leads WHERE source = $1 AND external_id = $2',
    [source, String(externalId)]
  );
  return res.rows[0] || null;
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

// ─── The admin Leads page: its list, and the fingerprint of that list ───
//
// The page polls every 45 seconds and nearly always finds the list it already
// has. So GET /api/leads first asks for getLeadListFingerprint(), one
// 32-character md5, and reads the list only when the browser does not hold
// that fingerprint already (October 2026: the database's monthly transfer
// allowance was nearly spent, and a whole-row page was ~28 KB a poll).
//
// Both run the statement leadListPage() builds, so the fingerprint covers
// exactly the rows, the order and the columns the list sends: a change to any
// of them moves it, and a change to anything else (the raw Meta payload, the
// Bitrix id, the SMS sender) costs nothing. When the list IS read, its
// fingerprint comes back in the same statement, so the ETag sent with a list
// always names that very list: see server/routes/leadsRoutes.js.

/** What the page renders, and all the list sends. Add a column here, not in a second list. */
const LEAD_LIST_COLUMNS = 'id, source, full_name, email, phone, job_title, message, bitrix_status, created_at';

/** Newest first; `id` breaks a tie, so the order never depends on the plan. */
const LEAD_LIST_ORDER = 'created_at DESC, id DESC';

/** The page of leads the admin list shows, as one parameterised statement. */
function leadListPage(limit, source) {
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 100, 1), 500);
  if (source) {
    return {
      text: `SELECT ${LEAD_LIST_COLUMNS} FROM leads WHERE source = $1 ORDER BY ${LEAD_LIST_ORDER} LIMIT $2`,
      values: [source, safeLimit],
    };
  }
  return {
    text: `SELECT ${LEAD_LIST_COLUMNS} FROM leads ORDER BY ${LEAD_LIST_ORDER} LIMIT $1`,
    values: [safeLimit],
  };
}

/** The md5 of a page, over the relation `page`. An empty page has one too. */
const LEAD_LIST_FINGERPRINT =
  `md5(COALESCE(json_agg(json_build_array(${LEAD_LIST_COLUMNS}) ORDER BY ${LEAD_LIST_ORDER})::text, ''))`;

/**
 * The fingerprint of the page listLeadsWithFingerprint(limit, source) would
 * return: the only thing sent back is the 32 characters.
 */
async function getLeadListFingerprint(limit = 100, source = null) {
  const page = leadListPage(limit, source);
  const res = await query(
    `SELECT ${LEAD_LIST_FINGERPRINT} AS fingerprint FROM (${page.text}) AS page`,
    page.values
  );
  return res.rows[0].fingerprint;
}

/**
 * The page, and the fingerprint of exactly that page. ONE statement, so one
 * snapshot: a write landing while the list is read cannot leave it under the
 * fingerprint of another state. The LEFT JOIN keeps one row when the page is
 * empty, to carry the fingerprint; that row has no lead in it.
 */
async function listLeadsWithFingerprint(limit = 100, source = null) {
  const page = leadListPage(limit, source);
  const res = await query(
    `WITH page AS MATERIALIZED (${page.text}),
          stamp AS (SELECT ${LEAD_LIST_FINGERPRINT} AS fingerprint FROM page)
     SELECT stamp.fingerprint, page.*
       FROM stamp LEFT JOIN page ON true
      ORDER BY ${LEAD_LIST_ORDER}`,
    page.values
  );
  const leads = res.rows
    .filter((row) => row.id != null)
    .map(({ fingerprint, ...lead }) => lead);
  return { leads, fingerprint: res.rows[0].fingerprint };
}


module.exports = {
  createLeadIfNew,
  updateLeadBitrixResult,
  updateLeadSmsSender,
  getLeadBySourceExternalId,
  getLeadListFingerprint,
  listLeadsWithFingerprint,
};
