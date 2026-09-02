/**
 * RECRUITERS — database helpers.
 *
 * One row per recruiter, with optional per-recruiter RingCentral credentials
 * (encrypted; the account-level settings row is the fallback). Phone numbers are
 * normalized on write so an inbound call can be matched back to its recruiter.
 *
 * The public leaderboard exposes names and KPI numbers only — never phone
 * numbers (APP_BRIEF §4), which is why toAdminRecruiter() masks secrets.
 *
 * Split out of database/ringcentral.js, which re-exports every symbol here.
 */
const { query } = require('../pool');
const { encryptText } = require('../../services/facebookCrypto');
const { safeDecrypt, maskKey } = require('./secrets');
const { getRcConfig } = require('./settings');

/** Digits-only, last-10 form so "+1 (470) 480-4679" == "4704804679". */
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
 * JWT is always the recruiter's own (JWTs are per-user). Client ID/Secret use
 * the recruiter's custom pair when stored, otherwise the shared pair from
 * ringcentral_settings / env.
 */
function resolveRecruiterRcAuth(recruiter, globalCfg) {
  const customClientId = safeDecrypt(recruiter?.client_id_encrypted);
  const customClientSecret = safeDecrypt(recruiter?.client_secret_encrypted);
  const usesCustomClient = Boolean(customClientId || customClientSecret);
  return {
    apiBase: globalCfg.apiBase,
    clientId: customClientId || globalCfg.clientId || '',
    clientSecret: customClientSecret || globalCfg.clientSecret || '',
    jwtToken: safeDecrypt(recruiter?.jwt_token_encrypted) || '',
    usesCustomClient,
  };
}

/** Masked recruiter view for the admin UI — secrets never returned raw. */
function toAdminRecruiter(row) {
  const jwt = safeDecrypt(row.jwt_token_encrypted);
  const clientId = safeDecrypt(row.client_id_encrypted);
  const clientSecret = safeDecrypt(row.client_secret_encrypted);
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
  const pushSecret = (column, rawValue, clearFlag) => {
    if (clearFlag) { sets.push(`${column} = NULL`); return; }
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (value) { sets.push(`${column} = $${i++}`); values.push(encryptText(value)); }
  };
  pushSecret('jwt_token_encrypted', jwtToken, clearJwtToken);
  pushSecret('client_id_encrypted', clientId, clearClientCreds);
  pushSecret('client_secret_encrypted', clientSecret, clearClientCreds);
  return i;
}

async function createRecruiter({ name, phoneNumber, active = true, jwtToken, clientId, clientSecret }) {
  const normalized = normalizePhone(phoneNumber);
  if (!name || !String(name).trim()) throw new Error('Recruiter name is required.');
  if (!normalized) throw new Error('A valid phone number is required.');
  const res = await query(
    `INSERT INTO recruiters
       (name, phone_number, phone_number_normalized, active,
        jwt_token_encrypted, client_id_encrypted, client_secret_encrypted)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      String(name).trim(), String(phoneNumber).trim(), normalized, active !== false,
      jwtToken && String(jwtToken).trim() ? encryptText(String(jwtToken).trim()) : null,
      clientId && String(clientId).trim() ? encryptText(String(clientId).trim()) : null,
      clientSecret && String(clientSecret).trim() ? encryptText(String(clientSecret).trim()) : null,
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

module.exports = {
  normalizePhone,
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
};
