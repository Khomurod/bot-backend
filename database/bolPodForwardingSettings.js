/**
 * BOL/POD document-forwarding settings — single-row store (id = 1).
 *
 * Backs Settings → BOL / POD. Controls the admin-driven forwarding of DataTruck
 * Bill of Lading / Proof of Delivery documents to Telegram groups. OFF by
 * default: nothing is forwarded until an administrator enables the feature.
 *
 * No secrets are stored here (the Telegram bot token stays server-side, read
 * from config). Telegram group ids are not secrets and are returned in
 * plaintext. All writes are parameterized and validated against allow-lists.
 */
const { query } = require('./db');

const CACHE_TTL_MS = 30_000;
let cache = null;
let cacheExpiresAt = 0;

const DELIVERY_MODES = ['driver_group', 'central_group', 'both'];
const DOCUMENT_TYPE_MODES = ['bol', 'pod', 'both'];
const UNCERTAIN_POLICIES = ['do_not_send', 'central_review'];

// Modes that route documents to the configured central group. Enabling the
// feature in one of these requires a validated central group.
const MODES_REQUIRING_CENTRAL = new Set(['central_group', 'both']);

/** A user-input validation failure; the route maps this to HTTP 400. */
class BolPodSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BolPodSettingsError';
    this.statusCode = 400;
  }
}

function invalidateCache() {
  cache = null;
  cacheExpiresAt = 0;
}

async function getSettingsRow() {
  try {
    const res = await query('SELECT * FROM bol_pod_forwarding_settings WHERE id = 1');
    return res.rows[0] || null;
  } catch (err) {
    console.warn('[BOL/POD SETTINGS] bol_pod_forwarding_settings unavailable:', err.message);
    return null;
  }
}

/**
 * Normalize + validate a Telegram chat id. Accepts a numeric string/number,
 * optionally negative (groups/supergroups/channels are negative). Returns the
 * canonical string form, or null when the input is blank. Throws on garbage.
 */
function normalizeCentralGroupId(raw) {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  if (!str) return null;
  if (!/^-?\d{1,20}$/.test(str)) {
    throw new BolPodSettingsError('Central group id must be a numeric Telegram chat id.');
  }
  return str;
}

/**
 * Effective settings for server-side use (the forwarding engine). DB row wins;
 * safe defaults apply before the row exists. Cached for CACHE_TTL_MS. Group id
 * is returned as a string to avoid BIGINT precision loss.
 */
async function getBolPodConfig() {
  const now = Date.now();
  if (cache && now < cacheExpiresAt) return cache;

  const row = await getSettingsRow();
  const effective = {
    enabled: row ? row.enabled === true : false,
    deliveryMode: DELIVERY_MODES.includes(row?.delivery_mode) ? row.delivery_mode : 'driver_group',
    centralGroupId: row?.central_group_id != null ? String(row.central_group_id) : null,
    centralGroupTitle: row?.central_group_title || null,
    centralGroupValidatedAt: row?.central_group_validated_at || null,
    documentTypeMode: DOCUMENT_TYPE_MODES.includes(row?.document_type_mode) ? row.document_type_mode : 'both',
    uncertainDocumentPolicy: UNCERTAIN_POLICIES.includes(row?.uncertain_document_policy)
      ? row.uncertain_document_policy
      : 'do_not_send',
    lastTestedAt: row?.last_tested_at || null,
    updatedAt: row?.updated_at || null,
    updatedBy: row?.updated_by || null,
  };

  cache = effective;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return effective;
}

/** Admin view (no secrets). Adds derived flags the UI uses for gating. */
async function getBolPodSettingsForAdmin() {
  const cfg = await getBolPodConfig();
  return {
    ...cfg,
    centralGroupConfigured: Boolean(cfg.centralGroupId),
    centralGroupValidated: Boolean(cfg.centralGroupValidatedAt),
  };
}

/**
 * Update settings. Omitted fields are left unchanged. Enums are validated
 * against allow-lists. Changing central_group_id clears its prior validation
 * (title + validated_at) because a different group must be re-validated. The
 * feature cannot be enabled in a central-routing mode without a validated
 * central group.
 */
async function updateBolPodSettings(payload = {}, { updatedBy = null } = {}) {
  const row = (await getSettingsRow()) || {};
  const sets = [];
  const values = [];
  let i = 1;
  const push = (column, value) => { sets.push(`${column} = $${i++}`); values.push(value); };

  // Resolve the post-update state so the enable-guard can validate the *result*.
  let nextEnabled = row.enabled === true;
  let nextMode = DELIVERY_MODES.includes(row.delivery_mode) ? row.delivery_mode : 'driver_group';
  let nextCentralId = row.central_group_id != null ? String(row.central_group_id) : null;
  let nextValidatedAt = row.central_group_validated_at || null;

  if (payload.enabled !== undefined) {
    if (typeof payload.enabled !== 'boolean') {
      throw new BolPodSettingsError('enabled must be a boolean.');
    }
    nextEnabled = payload.enabled;
    push('enabled', payload.enabled);
  }

  if (payload.deliveryMode !== undefined) {
    if (!DELIVERY_MODES.includes(payload.deliveryMode)) {
      throw new BolPodSettingsError(`Invalid delivery mode. Use one of: ${DELIVERY_MODES.join(', ')}.`);
    }
    nextMode = payload.deliveryMode;
    push('delivery_mode', payload.deliveryMode);
  }

  if (payload.documentTypeMode !== undefined) {
    if (!DOCUMENT_TYPE_MODES.includes(payload.documentTypeMode)) {
      throw new BolPodSettingsError(`Invalid document type mode. Use one of: ${DOCUMENT_TYPE_MODES.join(', ')}.`);
    }
    push('document_type_mode', payload.documentTypeMode);
  }

  if (payload.uncertainDocumentPolicy !== undefined) {
    if (!UNCERTAIN_POLICIES.includes(payload.uncertainDocumentPolicy)) {
      throw new BolPodSettingsError(`Invalid uncertain-document policy. Use one of: ${UNCERTAIN_POLICIES.join(', ')}.`);
    }
    push('uncertain_document_policy', payload.uncertainDocumentPolicy);
  }

  if (payload.centralGroupId !== undefined || payload.clearCentralGroup) {
    const newId = payload.clearCentralGroup ? null : normalizeCentralGroupId(payload.centralGroupId);
    if (newId !== nextCentralId) {
      // Different group (or cleared): its prior validation no longer applies.
      push('central_group_id', newId);
      push('central_group_title', null);
      push('central_group_validated_at', null);
      nextCentralId = newId;
      nextValidatedAt = null;
    }
  }

  // Enable-guard: cannot turn the feature on in a central-routing mode unless a
  // central group is configured AND validated (in the resulting state).
  if (nextEnabled && MODES_REQUIRING_CENTRAL.has(nextMode)) {
    if (!nextCentralId) {
      throw new BolPodSettingsError('Configure a central group before enabling this delivery mode.');
    }
    if (!nextValidatedAt) {
      throw new BolPodSettingsError('Validate the central group before enabling this delivery mode.');
    }
  }

  if (!sets.length) {
    invalidateCache();
    return getBolPodSettingsForAdmin();
  }
  push('updated_by', updatedBy);
  sets.push('updated_at = NOW()');
  await query(`UPDATE bol_pod_forwarding_settings SET ${sets.join(', ')} WHERE id = 1`, values);
  invalidateCache();
  return getBolPodSettingsForAdmin();
}

/**
 * Persist a successful central-group validation: store the id (canonicalized),
 * the resolved title, and stamp validated_at. Called by the validate endpoint
 * after the Telegram checks pass.
 */
async function setValidatedCentralGroup({ centralGroupId, title, updatedBy = null }) {
  const id = normalizeCentralGroupId(centralGroupId);
  if (!id) throw new BolPodSettingsError('A central group id is required.');
  await query(
    `UPDATE bol_pod_forwarding_settings
     SET central_group_id = $1,
         central_group_title = $2,
         central_group_validated_at = NOW(),
         updated_by = $3,
         updated_at = NOW()
     WHERE id = 1`,
    [id, title || null, updatedBy]
  );
  invalidateCache();
  return getBolPodSettingsForAdmin();
}

/** Stamp last_tested_at after a successful test message. */
async function markCentralGroupTested({ updatedBy = null } = {}) {
  await query(
    `UPDATE bol_pod_forwarding_settings
     SET last_tested_at = NOW(), updated_by = $1, updated_at = NOW()
     WHERE id = 1`,
    [updatedBy]
  );
  invalidateCache();
  return getBolPodSettingsForAdmin();
}

module.exports = {
  getBolPodConfig,
  getBolPodSettingsForAdmin,
  updateBolPodSettings,
  setValidatedCentralGroup,
  markCentralGroupTested,
  normalizeCentralGroupId,
  invalidateCache,
  BolPodSettingsError,
  DELIVERY_MODES,
  DOCUMENT_TYPE_MODES,
  UNCERTAIN_POLICIES,
  MODES_REQUIRING_CENTRAL,
};
