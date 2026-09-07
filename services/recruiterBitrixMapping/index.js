/**
 * Map recruiters to their Bitrix users — the orchestration.
 *
 * WHY THIS EXISTS. `recruiters.bitrix_user_id` is what decides whose
 * RingCentral number texts a Facebook lead: the lead is assigned to a Bitrix
 * user, and that id is the only link back to a recruiter row. Until it is
 * filled in, every lead falls back to the shared number. Filling it in by hand
 * means opening each Bitrix profile, reading the id out of the URL, and typing
 * it into the panel — per recruiter, and again for every new hire.
 *
 * This reads the Bitrix user directory and does that matching, applying only
 * the matches that are strong AND unambiguous (see ./match.js for the tiers
 * and why the weak tier is proposed rather than written).
 *
 * Two entry points, deliberately: PREVIEW changes nothing, APPLY writes. The
 * admin panel previews first, so an operator sees the plan before any row is
 * touched.
 */
const rc = require('../../database/ringcentral');
const { fetchBitrixUsers, webhookHost } = require('./directory');
const { matchRecruitersToBitrixUsers } = require('./match');

const EMPTY_PLAN = {
  apply: [], propose: [], alreadyMapped: [], ambiguous: [], conflicts: [], unmatched: [],
};

/** Why a directory read failed, in words an operator can act on. */
const FAILURE_MESSAGES = {
  not_configured: 'Bitrix24 is not configured, so there is no user directory to read.',
  no_user_scope:
    'The Bitrix webhook cannot read the user directory. Regenerate the inbound '
    + 'webhook with the "user" scope added to "crm", then try again — or map the ids by hand.',
  rest_error: 'Bitrix refused the user directory request.',
  request_failed: 'Could not reach Bitrix to read the user directory.',
};

/** The admin recruiter shape, reduced to what matching needs. */
function toMatchInput(recruiter) {
  return {
    id: recruiter.id,
    name: recruiter.name,
    phoneNumber: recruiter.phone_number,
    active: recruiter.active,
    bitrixUserId: recruiter.bitrixUserId,
  };
}

/**
 * What the mapping WOULD do. Reads Bitrix and the recruiter list; writes
 * nothing.
 */
async function previewRecruiterBitrixMapping({ fetchImpl } = {}) {
  const directory = await fetchBitrixUsers({ fetchImpl });
  if (!directory.ok) {
    return {
      ok: false,
      reason: directory.reason,
      message: FAILURE_MESSAGES[directory.reason] || 'Could not read the Bitrix user directory.',
      detail: directory.detail || null,
      bitrixUsers: 0,
      ...EMPTY_PLAN,
    };
  }

  const recruiters = await rc.listRecruitersForAdmin({ includeInactive: true });
  const plan = matchRecruitersToBitrixUsers({
    recruiters: recruiters.map(toMatchInput),
    users: directory.users,
  });

  return {
    ok: true,
    reason: null,
    message: null,
    bitrixUsers: directory.total,
    bitrixHost: webhookHost(),
    recruiters: recruiters.length,
    ...plan,
  };
}

/**
 * Apply the mapping. Writes `bitrix_user_id` for every strong, unambiguous
 * match, plus any first-name proposal whose recruiter id appears in `confirm`.
 *
 * An existing mapping is NEVER overwritten — a stored id is an operator's
 * decision, and a disagreement is reported as a mismatch instead.
 */
async function applyRecruiterBitrixMapping({ fetchImpl, confirm = [] } = {}) {
  const preview = await previewRecruiterBitrixMapping({ fetchImpl });
  if (!preview.ok) return { ...preview, applied: [], failed: [] };

  const confirmed = new Set(
    (Array.isArray(confirm) ? confirm : [])
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isFinite(value))
  );

  const queue = [
    ...preview.apply,
    ...preview.propose.filter((entry) => confirmed.has(entry.recruiterId)),
  ];

  const applied = [];
  const failed = [];
  for (const entry of queue) {
    try {
      const recruiter = await rc.updateRecruiter(entry.recruiterId, {
        bitrixUserId: entry.bitrixUserId,
      });
      if (recruiter) applied.push(entry);
      else failed.push({ ...entry, error: 'Recruiter no longer exists' });
    } catch (err) {
      // The partial unique index rejects a duplicate id; report it per row
      // rather than abandoning the rest of the plan.
      failed.push({ ...entry, error: err.message });
    }
  }

  return { ...preview, applied, failed };
}

module.exports = {
  FAILURE_MESSAGES,
  toMatchInput,
  previewRecruiterBitrixMapping,
  applyRecruiterBitrixMapping,
};
