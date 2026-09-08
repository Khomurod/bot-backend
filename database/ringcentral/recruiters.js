/**
 * RECRUITERS — database helpers.
 *
 * One row per recruiter, with optional per-recruiter RingCentral credentials
 * (encrypted; the account-level settings row is the fallback). Phone numbers are
 * normalized on write so an inbound call can be matched back to its recruiter.
 *
 * TWO CREDENTIAL MODES, and the order matters:
 *   'oauth' — refresh_token_encrypted, from the recruiter logging in themselves
 *             (/ringcentral/connect). PREFERRED: nobody has to handle a secret
 *             by hand. The token expires in 7 days and rotates on every use, so
 *             this column is rewritten by the refresh path, not written once.
 *   'jwt'   — jwt_token_encrypted, pasted by an admin. The original path, kept
 *             working and used when there is no refresh token.
 * Either one authorizes THAT recruiter's extension only: RingCentral refuses an
 * SMS whose `from` is another extension's number, whoever the token belongs to.
 * bitrix_user_id is what connects a Bitrix assignment back to one of these rows.
 *
 * The public leaderboard exposes names and KPI numbers only — never phone
 * numbers (APP_BRIEF §4), which is why toAdminRecruiter() masks secrets.
 *
 * Split out of database/ringcentral.js, which re-exports every symbol here.
 */
const { query } = require('../pool');
const { encryptText } = require('../../lib/security/facebookCrypto');
const { safeDecrypt, maskKey } = require('./secrets');
const { getRcConfig } = require('./settings');

/**
 * Digits-only, last-10 form so "+1 (470) 480-4679" == "4704804679".
 *
 * DELIBERATELY NOT `lib/phone/e164.js`'s `phoneKey`, which is otherwise the
 * same function: this one lets a short value through unchanged, and it writes
 * `recruiters.phone_number_normalized`, which is `TEXT NOT NULL UNIQUE`.
 * Collapsing every short value to '' — as `phoneKey` does, so an extension
 * never matches a phone number — would make two such rows collide on that
 * index. Use `phoneKey` for comparisons and `toE164` for anything sendable;
 * this stays as the column's own encoding.
 */
function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// ─── Recruiters ───

async function listRecruiters({ includeInactive = true } = {}) {
  const res = await query(
    `SELECT * FROM recruiters ${includeInactive ? '' : 'WHERE active = TRUE'} ORDER BY name ASC`
  );
  return res.rows;
}

async function getRecruiterById(id) {
  const res = await query('SELECT * FROM recruiters WHERE id = $1', [id]);
  return res.rows[0] || null;
}

/**
 * Resolve the effective RingCentral auth for one recruiter's number.
 *
 * JWT and refresh token are always the recruiter's OWN (both represent that
 * user). Client ID/Secret use the recruiter's custom pair when stored,
 * otherwise the shared pair from ringcentral_settings / env.
 *
 * `mode` says which credential wins: 'oauth' (refresh token, preferred) over
 * 'jwt' (pasted), and 'none' when the recruiter has neither and can only be
 * covered by the shared sending number.
 */
function resolveRecruiterRcAuth(recruiter, globalCfg) {
  const customClientId = safeDecrypt(recruiter?.client_id_encrypted);
  const customClientSecret = safeDecrypt(recruiter?.client_secret_encrypted);
  const usesCustomClient = Boolean(customClientId || customClientSecret);
  const refreshToken = safeDecrypt(recruiter?.refresh_token_encrypted) || '';
  const jwtToken = safeDecrypt(recruiter?.jwt_token_encrypted) || '';
  return {
    recruiterId: recruiter?.id ?? null,
    apiBase: globalCfg.apiBase,
    clientId: customClientId || globalCfg.clientId || '',
    clientSecret: customClientSecret || globalCfg.clientSecret || '',
    jwtToken,
    refreshToken,
    extensionId: recruiter?.rc_extension_id || null,
    fromNumber: recruiter?.phone_number || '',
    mode: refreshToken ? 'oauth' : (jwtToken ? 'jwt' : 'none'),
    usesCustomClient,
  };
}

/** Digits-only positive integer, or null for "not set" / "clear it". */
function normalizeBitrixUserId(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) && num > 0 ? num : null;
}

/** Masked recruiter view for the admin UI — secrets never returned raw. */
function toAdminRecruiter(row) {
  const jwt = safeDecrypt(row.jwt_token_encrypted);
  const clientId = safeDecrypt(row.client_id_encrypted);
  const clientSecret = safeDecrypt(row.client_secret_encrypted);
  const refreshToken = safeDecrypt(row.refresh_token_encrypted);
  const authMode = refreshToken ? 'oauth' : (jwt ? 'jwt' : 'none');
  return {
    id: row.id,
    name: row.name,
    phone_number: row.phone_number,
    active: row.active,
    jwtTokenSet: Boolean(jwt),
    jwtTokenMasked: maskKey(jwt),
    usesCustomClient: Boolean(clientId || clientSecret),
    clientIdSet: Boolean(clientId),
    clientIdMasked: maskKey(clientId),
    clientSecretSet: Boolean(clientSecret),
    clientSecretMasked: maskKey(clientSecret),
    // Sender identity. `canSendSms` is what decides whether a lead assigned to
    // this recruiter is texted from their number or from the shared one.
    bitrixUserId: row.bitrix_user_id ?? null,
    authMode,
    canSendSms: recruiterCanSendSms(row),
    oauthConnected: Boolean(refreshToken),
    rcExtensionId: row.rc_extension_id || null,
    rcExtensionNumber: row.rc_extension_number || null,
    rcAuthorizedAt: row.rc_authorized_at || null,
    rcTokenRefreshedAt: row.rc_token_refreshed_at || null,
    rcAuthError: row.rc_auth_error || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function listRecruitersForAdmin({ includeInactive = true } = {}) {
  const rows = await listRecruiters({ includeInactive });
  return rows.map(toAdminRecruiter);
}

/** Build the SET fragments for the per-recruiter secret columns. */
function recruiterSecretSets({ jwtToken, clientId, clientSecret, clearJwtToken, clearClientCreds }, sets, values, startIndex) {
  let i = startIndex;
  let credentialChanged = false;
  const pushSecret = (column, rawValue, clearFlag) => {
    if (clearFlag) { sets.push(`${column} = NULL`); credentialChanged = true; return; }
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (value) {
      sets.push(`${column} = $${i++}`);
      values.push(encryptText(value));
      credentialChanged = true;
    }
  };
  pushSecret('jwt_token_encrypted', jwtToken, clearJwtToken);
  pushSecret('client_id_encrypted', clientId, clearClientCreds);
  pushSecret('client_secret_encrypted', clientSecret, clearClientCreds);

  // A NEW credential may belong to a DIFFERENT RingCentral account, so the
  // extension recorded against the old one is no longer this recruiter's.
  // Leaving it would keep the inbound-SMS subscription watching a stranger's
  // extension while replies to the number they now text from reach nobody —
  // and `recruiterExtensionIdentity` only re-reads an identity that is MISSING,
  // so a stale one is never corrected. Clearing it makes the next pass of
  // ringCentralTokenRefreshService (boot, then daily) fetch the right one.
  if (credentialChanged) {
    sets.push('rc_extension_id = NULL');
    sets.push('rc_extension_number = NULL');
  }
  return i;
}

async function createRecruiter({
  name, phoneNumber, active = true, jwtToken, clientId, clientSecret,
  bitrixUserId, refreshToken, rcExtensionId, rcExtensionNumber,
}) {
  const normalized = normalizePhone(phoneNumber);
  if (!name || !String(name).trim()) throw new Error('Recruiter name is required.');
  if (!normalized) throw new Error('A valid phone number is required.');
  const hasRefresh = Boolean(refreshToken && String(refreshToken).trim());
  const res = await query(
    `INSERT INTO recruiters
       (name, phone_number, phone_number_normalized, active,
        jwt_token_encrypted, client_id_encrypted, client_secret_encrypted,
        bitrix_user_id, refresh_token_encrypted, rc_extension_id, rc_extension_number,
        rc_authorized_at, rc_token_refreshed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             CASE WHEN $9::text IS NULL THEN NULL ELSE NOW() END,
             CASE WHEN $9::text IS NULL THEN NULL ELSE NOW() END)
     RETURNING *`,
    [
      String(name).trim(), String(phoneNumber).trim(), normalized, active !== false,
      jwtToken && String(jwtToken).trim() ? encryptText(String(jwtToken).trim()) : null,
      clientId && String(clientId).trim() ? encryptText(String(clientId).trim()) : null,
      clientSecret && String(clientSecret).trim() ? encryptText(String(clientSecret).trim()) : null,
      normalizeBitrixUserId(bitrixUserId),
      hasRefresh ? encryptText(String(refreshToken).trim()) : null,
      rcExtensionId ? String(rcExtensionId) : null,
      rcExtensionNumber ? String(rcExtensionNumber) : null,
    ]
  );
  return toAdminRecruiter(res.rows[0]);
}

async function updateRecruiter(id, payload = {}) {
  const { name, phoneNumber, active } = payload;
  const sets = [];
  const values = [];
  let i = 1;
  if (typeof name === 'string' && name.trim()) { sets.push(`name = $${i++}`); values.push(name.trim()); }
  if (typeof phoneNumber === 'string' && phoneNumber.trim()) {
    const normalized = normalizePhone(phoneNumber);
    if (!normalized) throw new Error('A valid phone number is required.');
    sets.push(`phone_number = $${i++}`); values.push(phoneNumber.trim());
    sets.push(`phone_number_normalized = $${i++}`); values.push(normalized);
  }
  if (typeof active === 'boolean') { sets.push(`active = $${i++}`); values.push(active); }
  // Bitrix mapping: an explicit null/'' clears it, a number sets it, and
  // `undefined` (the field simply absent) leaves whatever is stored.
  if (payload.bitrixUserId !== undefined) {
    sets.push(`bitrix_user_id = $${i++}`);
    values.push(normalizeBitrixUserId(payload.bitrixUserId));
  }
  i = recruiterSecretSets(payload, sets, values, i);
  if (!sets.length) {
    const cur = await getRecruiterById(id);
    return cur ? toAdminRecruiter(cur) : null;
  }
  sets.push('updated_at = NOW()');
  values.push(id);
  const res = await query(`UPDATE recruiters SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, values);
  return res.rows[0] ? toAdminRecruiter(res.rows[0]) : null;
}

async function deleteRecruiter(id) {
  await query('DELETE FROM recruiters WHERE id = $1', [id]);
}

async function getRecruiterByNormalizedNumber(normalized) {
  if (!normalized) return null;
  const res = await query('SELECT * FROM recruiters WHERE phone_number_normalized = $1', [normalized]);
  return res.rows[0] || null;
}

/**
 * True when this recruiter can send an SMS AS THEMSELVES: a number to send
 * from, plus a credential of their own. The single definition of "sendable" —
 * the admin view, the lead sender and the refresh job all ask this question.
 */
function recruiterCanSendSms(row) {
  if (!row || !row.phone_number) return false;
  return Boolean(safeDecrypt(row.refresh_token_encrypted) || safeDecrypt(row.jwt_token_encrypted));
}

/**
 * Is there any point asking Bitrix who owns a new lead?
 *
 * Cheap pre-check (one COUNT) so a deployment that has not mapped any recruiter
 * to a Bitrix user keeps the old behaviour with NO added latency: no assignee
 * poll, straight to the shared number. Counts on the raw columns, so it is an
 * upper bound — recruiterCanSendSms() still decides per row.
 */
async function hasMappedSmsSenders() {
  const res = await query(
    `SELECT EXISTS (
       SELECT 1 FROM recruiters
        WHERE active = TRUE
          AND bitrix_user_id IS NOT NULL
          AND phone_number IS NOT NULL
          AND (refresh_token_encrypted IS NOT NULL OR jwt_token_encrypted IS NOT NULL)
     ) AS present`
  );
  return res.rows[0]?.present === true;
}

/** The recruiter a Bitrix assignment (ASSIGNED_BY_ID) belongs to, if any. */
async function getRecruiterByBitrixUserId(bitrixUserId) {
  const id = normalizeBitrixUserId(bitrixUserId);
  if (id === null) return null;
  const res = await query('SELECT * FROM recruiters WHERE bitrix_user_id = $1', [id]);
  return res.rows[0] || null;
}

/**
 * Record a completed RingCentral authorization: the refresh token plus the
 * extension identity read back from RingCentral. Clears any previous auth
 * error, because a fresh login is exactly what fixes one.
 */
async function storeRecruiterOAuthTokens(id, { refreshToken, extensionId = null, extensionNumber = null }) {
  const token = String(refreshToken || '').trim();
  if (!token) throw new Error('A refresh token is required.');
  const res = await query(
    `UPDATE recruiters
        SET refresh_token_encrypted = $2,
            rc_extension_id = COALESCE($3, rc_extension_id),
            rc_extension_number = COALESCE($4, rc_extension_number),
            rc_authorized_at = NOW(),
            rc_token_refreshed_at = NOW(),
            rc_auth_error = NULL,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, encryptText(token), extensionId ? String(extensionId) : null, extensionNumber ? String(extensionNumber) : null]
  );
  return res.rows[0] || null;
}

/**
 * Record the RingCentral extension a recruiter's credential belongs to.
 *
 * WHY THIS EXISTS SEPARATELY from storeRecruiterOAuthTokens: that one runs only
 * when a recruiter signs in through the OAuth flow, so a recruiter onboarded by
 * an admin pasting a JWT had `rc_extension_id` NULL forever — they could send
 * SMS perfectly well, but the inbound-SMS subscription is built one filter per
 * extension id, so a NULL meant their extension was never watched and every
 * driver reply to their number reached nobody. `updateRecruiter` has no branch
 * for these columns and the admin panel has no input for them, so nothing could
 * fill the gap.
 *
 * Identity only: no credential is read or written here.
 */
async function updateRecruiterRcIdentity(id, { extensionId = null, extensionNumber = null } = {}) {
  const ext = extensionId != null && String(extensionId).trim() ? String(extensionId).trim() : null;
  const num = extensionNumber != null && String(extensionNumber).trim() ? String(extensionNumber).trim() : null;
  if (!ext && !num) return null;
  const res = await query(
    `UPDATE recruiters
        SET rc_extension_id = COALESCE($2, rc_extension_id),
            rc_extension_number = COALESCE($3, rc_extension_number),
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, ext, num]
  );
  return res.rows[0] || null;
}

/**
 * Persist a ROTATED refresh token. RingCentral issues a new refresh token on
 * every refresh and invalidates the old one, so failing to store this is how a
 * working recruiter silently stops sending a week later.
 */
async function updateRecruiterRefreshToken(id, refreshToken) {
  const token = String(refreshToken || '').trim();
  if (!token) throw new Error('A refresh token is required.');
  await query(
    `UPDATE recruiters
        SET refresh_token_encrypted = $2,
            rc_token_refreshed_at = NOW(),
            rc_auth_error = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [id, encryptText(token)]
  );
}

/** Flag a recruiter whose credentials no longer work, for the admin panel. */
async function markRecruiterAuthError(id, message) {
  await query(
    'UPDATE recruiters SET rc_auth_error = $2, updated_at = NOW() WHERE id = $1',
    [id, message ? String(message).slice(0, 500) : null]
  );
}

/** Forget a recruiter's RingCentral login (admin action, or a revoked grant). */
async function clearRecruiterOAuth(id) {
  const res = await query(
    `UPDATE recruiters
        SET refresh_token_encrypted = NULL,
            rc_authorized_at = NULL,
            rc_token_refreshed_at = NULL,
            rc_auth_error = NULL,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id]
  );
  return res.rows[0] ? toAdminRecruiter(res.rows[0]) : null;
}

/**
 * Active recruiters holding their own credentials — the rows the token-refresh
 * job and the per-extension inbound-SMS subscription both work from.
 */
async function listRecruitersWithOwnCredentials() {
  const res = await query(
    `SELECT * FROM recruiters
      WHERE active = TRUE
        AND (refresh_token_encrypted IS NOT NULL OR jwt_token_encrypted IS NOT NULL)
      ORDER BY name ASC`
  );
  return res.rows;
}

module.exports = {
  normalizePhone,
  normalizeBitrixUserId,
  recruiterCanSendSms,
  hasMappedSmsSenders,
  listRecruiters,
  getRecruiterById,
  resolveRecruiterRcAuth,
  toAdminRecruiter,
  listRecruitersForAdmin,
  recruiterSecretSets,
  createRecruiter,
  updateRecruiter,
  deleteRecruiter,
  getRecruiterByNormalizedNumber,
  getRecruiterByBitrixUserId,
  storeRecruiterOAuthTokens,
  updateRecruiterRcIdentity,
  updateRecruiterRefreshToken,
  markRecruiterAuthError,
  clearRecruiterOAuth,
  listRecruitersWithOwnCredentials,
};
