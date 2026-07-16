/**
 * Resolves an assignment's live GPS.
 *
 * Its own module because BOTH the monitor pass and the completion-only
 * reconciliation need it — neither should have to depend on the other.
 */
const db = require('../../database/db');
const { resolveLiveLocationForGroupTitle } = require('../liveLocationResolver');

/**
 * Resolve an assignment's live GPS, preferring stable stored identifiers:
 * the assignment's stored unit_number → the group's current driver-profile
 * unit → group-title parsing (compatibility fallback inside the resolver).
 * Never throws — a failure is returned so the caller can diagnose it.
 */
async function resolveAssignmentLocation(assignment) {
  let unitNumber = assignment?.unit_number != null && String(assignment.unit_number).trim()
    ? String(assignment.unit_number).trim() : null;
  if (!unitNumber && assignment?.group_id) {
    try {
      const profile = await db.getDriverProfileByGroupId(assignment.group_id);
      if (profile?.unit_number) unitNumber = String(profile.unit_number).trim() || null;
    } catch (_) { /* fall through to group-title parsing */ }
  }
  try {
    const resolved = await resolveLiveLocationForGroupTitle(assignment?.group_name || '', { unitNumber });
    return { location: resolved.location, source: resolved.source, error: null };
  } catch (err) {
    return { location: null, source: null, error: err };
  }
}

module.exports = { resolveAssignmentLocation };
