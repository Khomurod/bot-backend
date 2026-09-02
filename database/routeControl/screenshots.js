/**
 * Route SCREENSHOTS — database helpers.
 *
 * At most one screenshot per assignment: the unique index on
 * `route_assignment_attachments` is what makes a replacement a single UPSERT
 * rather than a delete-then-insert that could momentarily lose the evidence.
 * The bytes reach Telegram as a short-lived signed URL, never as an upload from
 * this process (APP_BRIEF §9).
 *
 * Split out of database/routeControl.js, which re-exports every symbol here.
 */
const { query } = require('../pool');

/**
 * Store (or replace) the route screenshot for an assignment. One screenshot per
 * assignment, enforced by the uniq_route_assignment_attachment index: the
 * replacement is a single atomic UPSERT, so a failed upload can NEVER destroy
 * the previously stored screenshot, and two concurrent uploads can never leave
 * duplicate rows (last writer wins).
 */
async function saveRouteScreenshot(assignmentId, { mimeType, data, uploadedBy = null }) {
  if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('screenshot data buffer is required');
  const res = await query(
    `INSERT INTO route_assignment_attachments
       (assignment_id, kind, mime_type, file_size_bytes, file_data, uploaded_by)
     VALUES ($1, 'route_screenshot', $2, $3, $4, $5)
     ON CONFLICT (assignment_id, kind) DO UPDATE
       SET mime_type = EXCLUDED.mime_type,
           file_size_bytes = EXCLUDED.file_size_bytes,
           file_data = EXCLUDED.file_data,
           uploaded_by = EXCLUDED.uploaded_by,
           created_at = NOW()
     RETURNING id, assignment_id, kind, mime_type, file_size_bytes, uploaded_by, created_at`,
    [assignmentId, String(mimeType || 'image/png'), data.length, data, uploadedBy ? String(uploadedBy).slice(0, 128) : null]
  );
  return res.rows[0];
}

/** Fetch the route screenshot WITH bytes (Telegram send / auth-gated preview only). */
async function getRouteScreenshot(assignmentId) {
  const res = await query(
    `SELECT id, assignment_id, mime_type, file_size_bytes, file_data, uploaded_by, created_at
       FROM route_assignment_attachments
      WHERE assignment_id = $1 AND kind = 'route_screenshot'
      ORDER BY created_at DESC LIMIT 1`,
    [assignmentId]
  );
  return res.rows[0] || null;
}

/** Remove the route screenshot (admin "remove" action). */
async function deleteRouteScreenshot(assignmentId) {
  const res = await query(
    `DELETE FROM route_assignment_attachments
      WHERE assignment_id = $1 AND kind = 'route_screenshot'`,
    [assignmentId]
  );
  return { deleted: res.rowCount > 0 };
}

module.exports = {
  saveRouteScreenshot,
  getRouteScreenshot,
  deleteRouteScreenshot,
};
