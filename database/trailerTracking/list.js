/**
 * The trailer master list joined to current status — the admin list query.
 */

const { query } = require('../pool');
const { OFFICIAL_TRAILER_PREDICATE } = require('./status');

/**
 * Trailer master list joined to current status, with optional filters.
 * Filters: q (unit/plate/vin substring), status, ownership, type, needs_review,
 * master_status.
 *
 * Defaults to OFFICIAL trailers only. Pending-review, archived and merged
 * records keep all their history but are not assets, so they are reachable only
 * by asking for them explicitly (`master_status`), which is what the dedicated
 * master-list review section does.
 */
async function listTrailers(filters = {}) {
  const where = [];
  const vals = [];
  let i = 1;
  if (filters.q) {
    where.push(`(UPPER(t.unit_number) LIKE $${i} OR UPPER(COALESCE(t.plate_number,'')) LIKE $${i} OR UPPER(COALESCE(t.vin,'')) LIKE $${i})`);
    vals.push(`%${String(filters.q).toUpperCase()}%`);
    i++;
  }
  if (filters.master_status) {
    where.push(`t.master_status = $${i++}`);
    vals.push(String(filters.master_status));
  } else if (filters.include_unofficial !== true && filters.include_unofficial !== 'true') {
    where.push(OFFICIAL_TRAILER_PREDICATE);
  }
  if (filters.status) { where.push(`COALESCE(cs.current_status,'unknown') = $${i++}`); vals.push(String(filters.status)); }
  if (filters.ownership) { where.push(`t.ownership_status = $${i++}`); vals.push(String(filters.ownership)); }
  if (filters.type) { where.push(`t.type = $${i++}`); vals.push(String(filters.type)); }
  if (filters.needs_review === true || filters.needs_review === 'true') { where.push('t.needs_review = TRUE'); }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const res = await query(
    `SELECT t.*,
            cs.current_status,
            COALESCE(cs.possession_status, 'unknown') AS possession_status,
            COALESCE(cs.cargo_status, 'unknown') AS cargo_status,
            cs.display_status,
            cs.current_driver_group_id, cs.current_driver_name,
            cs.current_location_text, cs.current_lat, cs.current_lng,
            cs.current_condition, cs.last_reporter_name,
            cs.last_event_type, cs.last_event_at,
            cs.needs_review AS status_needs_review, cs.pending_event_id,
            cs.location_source AS current_location_source
     FROM trailers t
     LEFT JOIN trailer_current_status cs ON cs.trailer_id = t.id
     ${whereClause}
     ORDER BY cs.last_event_at DESC NULLS LAST, t.unit_number ASC
     LIMIT 1000`,
    vals
  );
  return res.rows;
}


module.exports = {
  listTrailers,
};
