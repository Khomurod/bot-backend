/**
 * Driver-raise dispatch-team roster: who a dispatch team covers and who its
 * dispatchers are.
 *
 * Admin-side only — nothing here sends a Telegram message or touches a review
 * round. Driver Groups / `driver_profiles` is the source of truth for driver
 * identity (NOT Datatruck); Datatruck is used only for the legacy
 * company-driver candidate list.
 */
const ra = require('../../database/raiseApproval');
const datatruck = require('../datatruckApiService');
const { normalizeDriverName } = require('../mileageBonusConstants');
const driverDirectory = require('../driverGroupDirectoryService');
const { normalizeTelegramUsername, isValidTelegramUsername } = require('../../lib/telegram/telegramUsername');
const { serviceError } = require('./errors');

// ─── Company-driver candidate list (Datatruck) ───

async function fetchCompanyDriverCandidates() {
  if (!datatruck.isConfigured()) {
    throw serviceError('DATATRUCK_NOT_CONFIGURED', 'Datatruck API is not configured.', 409);
  }
  const rows = await datatruck.fetchAllDrivers();
  const byName = new Map();
  for (const d of rows) {
    if (d.driver_type !== 'company_driver') continue;
    const fullName = d.account?.full_name
      || [d.account?.first_name, d.account?.last_name].filter(Boolean).join(' ');
    const normalized = normalizeDriverName(fullName);
    if (!normalized || byName.has(normalized)) continue;
    byName.set(normalized, {
      driver_external_id: d.id != null ? String(d.id) : null,
      driver_normalized_name: normalized,
      driver_name: fullName,
    });
  }
  return [...byName.values()].sort((a, b) => a.driver_name.localeCompare(b.driver_name));
}

// ─── Assignable-driver candidate list (Driver Groups = source of truth) ───

const DRIVER_ROLES = ['dispatcher', 'lead_dispatcher', 'manager'];

/** Project a canonical driver-group row into an assignable-driver candidate. */
function candidateFromDirectoryRow(row) {
  const driverName = row.display_name || row.primary_display_name || row.group_name || '';
  // Normalize on the primary member name so it matches the raise picks key
  // (raise_round_picks + legacy Datatruck rows both use normalizeDriverName).
  const normalized = normalizeDriverName(row.primary_display_name || row.display_name || driverName);
  const warnings = [];
  if (!row.first_name && !row.last_name && !row.display_name) warnings.push('missing_name');
  if (!row.unit_number) warnings.push('missing_unit');
  if (row.inactive) warnings.push('inactive_group');
  if (row.driver_type === 'owner') warnings.push('owner_operator');
  return {
    group_id: row.group_id,
    driver_profile_id: row.profile_id || null,
    driver_name: driverName,
    driver_normalized_name: normalized,
    display_name: row.display_name || null,
    first_name: row.first_name || null,
    last_name: row.last_name || null,
    secondary_first_name: row.secondary_first_name || null,
    secondary_last_name: row.secondary_last_name || null,
    unit_number: row.unit_number || null,
    group_name: row.group_name || null,
    telegram_group_id: row.telegram_group_id || null,
    driver_type: row.driver_type || null,
    inactive: Boolean(row.inactive),
    warnings,
  };
}

/**
 * List drivers that can be assigned to a dispatch team, sourced from Driver
 * Groups / driver_profiles (NOT Datatruck). Each candidate is annotated with
 * the team it is currently assigned to (if any) so the UI can surface conflicts.
 * Company-driver-only by default — the 72–75 CPM review business rule.
 */
async function listAssignableDrivers({ companyOnly = true, includeInactive = false, search = '' } = {}) {
  const rows = await driverDirectory.listCanonicalDriverGroups({ operational: true });
  const assignments = await ra.listActiveDriverAssignments();
  const byProfile = new Map();
  const byGroup = new Map();
  for (const a of assignments) {
    if (a.driver_profile_id != null) byProfile.set(Number(a.driver_profile_id), a);
    if (a.group_id != null) byGroup.set(Number(a.group_id), a);
  }
  const term = String(search || '').trim().toLowerCase();
  const out = [];
  for (const row of rows) {
    if (row.group_type !== 'driver') continue;
    if (companyOnly && row.driver_type === 'owner') continue;
    if (!includeInactive && row.inactive) continue;
    const cand = candidateFromDirectoryRow(row);
    const current = (row.profile_id != null && byProfile.get(Number(row.profile_id)))
      || byGroup.get(Number(row.group_id)) || null;
    cand.assigned_team_id = current ? current.team_id : null;
    cand.assigned_team_name = current ? current.team_name : null;
    if (term) {
      const hay = [cand.driver_name, cand.unit_number, cand.group_name, cand.driver_type]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(term)) continue;
    }
    out.push(cand);
  }
  out.sort((a, b) => String(a.driver_name || '').localeCompare(String(b.driver_name || '')));
  return out;
}

/**
 * Assign a driver (resolved from Driver Groups by group_id or driver_profile_id)
 * to a dispatch team. Delegates conflict/move handling to the DB layer.
 */
async function assignDriverToTeamFromGroups({
  teamId, groupId = null, driverProfileId = null, force = false,
}) {
  if (!teamId) throw serviceError('NO_TEAM', 'Select a dispatch team.', 400);
  if (!groupId && !driverProfileId) throw serviceError('NO_DRIVER', 'Select a driver to assign.', 400);
  const rows = await driverDirectory.listCanonicalDriverGroups({ operational: true });
  const row = rows.find((r) => r.group_type === 'driver' && (
    (driverProfileId && Number(r.profile_id) === Number(driverProfileId))
    || (groupId && Number(r.group_id) === Number(groupId))
  ));
  if (!row) throw serviceError('DRIVER_NOT_FOUND', 'That driver was not found in Driver Groups.', 404);
  const cand = candidateFromDirectoryRow(row);
  if (!cand.driver_normalized_name) {
    throw serviceError('NO_DRIVER_NAME',
      'This driver has no name in Driver Groups. Set the driver name there first.', 400);
  }
  return ra.assignDriverToTeam({
    teamId,
    driverProfileId: cand.driver_profile_id,
    groupId: cand.group_id,
    unitNumber: cand.unit_number,
    driverName: cand.driver_name,
    driverNormalizedName: cand.driver_normalized_name,
    force,
  });
}

// ─── Dispatch team members (dispatchers with Telegram usernames) ───

function sanitizeMemberInput(input = {}) {
  const out = {};
  if (input.name !== undefined) out.name = String(input.name || '').trim() || null;
  if (input.role !== undefined) {
    const role = String(input.role || '').trim() || null;
    if (role && !DRIVER_ROLES.includes(role)) throw serviceError('BAD_ROLE', 'Invalid role.', 400);
    out.role = role;
  }
  if (input.active !== undefined) out.active = Boolean(input.active);
  if (input.telegramUserId !== undefined) {
    const raw = input.telegramUserId;
    const id = raw == null || raw === '' ? null : Number(raw);
    if (id != null && !Number.isFinite(id)) {
      throw serviceError('BAD_USER_ID', 'Telegram user id must be numeric.', 400);
    }
    out.telegramUserId = id;
  }
  if (input.telegramUsername !== undefined) {
    const norm = normalizeTelegramUsername(input.telegramUsername);
    if (norm && !isValidTelegramUsername(norm)) {
      throw serviceError('BAD_USERNAME',
        'That does not look like a valid Telegram username (5–32 letters, digits, or underscores).', 400);
    }
    out.telegramUsername = norm;
  }
  return out;
}

async function createTeamMember(teamId, input = {}) {
  if (!teamId) throw serviceError('NO_TEAM', 'Select a dispatch team.', 400);
  const clean = sanitizeMemberInput(input);
  if (!clean.name && !clean.telegramUsername && clean.telegramUserId == null) {
    throw serviceError('EMPTY_MEMBER', 'Enter a name or a Telegram username.', 400);
  }
  return ra.createTeamMember(teamId, clean);
}

async function updateTeamMember(id, input = {}) {
  return ra.updateTeamMember(id, sanitizeMemberInput(input));
}

// ─── Legacy backfill: link name-only team-driver rows to driver profiles ───

/**
 * Best-effort, idempotent: link active dispatch_team_drivers rows that have no
 * driver_profile_id (legacy Datatruck-name rows) to a driver profile by
 * normalized name. Unmatched rows are flagged needs_review (kept, never deleted).
 */
async function backfillLegacyTeamDriverLinks() {
  const unlinked = await ra.listUnlinkedTeamDrivers();
  if (!unlinked.length) return { linked: 0, needsReview: 0 };
  const rows = await driverDirectory.listCanonicalDriverGroups({ operational: false });
  const byNorm = new Map();
  for (const r of rows) {
    if (r.group_type !== 'driver' || !r.profile_id) continue;
    const norm = normalizeDriverName(r.primary_display_name || r.display_name || r.group_name || '');
    if (norm && !byNorm.has(norm)) byNorm.set(norm, r);
  }
  let linked = 0;
  let needsReview = 0;
  for (const d of unlinked) {
    const match = byNorm.get(d.driver_normalized_name);
    if (match && match.profile_id) {
      try {
        await ra.linkTeamDriverToProfile(d.id, {
          driverProfileId: match.profile_id, groupId: match.group_id, unitNumber: match.unit_number,
        });
        linked += 1;
      } catch (err) {
        // e.g. the one-active-team-per-profile unique index rejected a second
        // legacy row for the same driver. Keep it, flag for manual review.
        await ra.markTeamDriverNeedsReview(d.id, true).catch(() => {});
        needsReview += 1;
      }
    } else if (!d.needs_review) {
      await ra.markTeamDriverNeedsReview(d.id, true);
      needsReview += 1;
    }
  }
  if (linked || needsReview) {
    console.log(`[RAISE] Legacy team-driver backfill: linked ${linked}, flagged ${needsReview} for review.`);
  }
  return { linked, needsReview };
}

module.exports = {
  DRIVER_ROLES,
  fetchCompanyDriverCandidates,
  candidateFromDirectoryRow,
  listAssignableDrivers,
  assignDriverToTeamFromGroups,
  sanitizeMemberInput,
  createTeamMember,
  updateTeamMember,
  backfillLegacyTeamDriverLinks,
};
