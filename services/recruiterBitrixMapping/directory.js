/**
 * The Bitrix24 user directory — read-only.
 *
 * One job: turn `user.get` into a normalized list this repo can match against.
 * It creates nothing and changes nothing in Bitrix.
 *
 * SCOPE. An inbound webhook only answers `user.get` if it was created with the
 * `user` scope. A webhook made for CRM alone answers ACCESS_DENIED, so that
 * case is detected and reported as the actionable thing it is ("regenerate the
 * webhook with the user scope") rather than a bare REST error.
 *
 * THE URL IS THE CREDENTIAL. A Bitrix inbound webhook authenticates by its
 * path, so the base URL never appears in a return value, a log line or an
 * error message here — only the host, and only where a caller asks for it.
 */
const config = require('../../config/config');
const { normalizeWebhookBase, isBitrixConfigured } = require('../bitrix24Service');

/** Bitrix pages user.get at 50; stop well before a runaway loop. */
const MAX_PAGES = 40;

const SCOPE_ERRORS = new Set([
  'ACCESS_DENIED',
  'INVALID_CREDENTIALS',
  'INSUFFICIENT_SCOPE',
  'NO_AUTH_FOUND',
  'METHOD_NOT_FOUND',
]);

/** One Bitrix user row → the fields matching actually uses. */
function normalizeBitrixUser(row) {
  const id = Number.parseInt(row?.ID ?? row?.id, 10);
  if (!Number.isFinite(id) || id <= 0) return null;

  const firstName = String(row?.NAME || '').trim();
  const lastName = String(row?.LAST_NAME || '').trim();
  const phones = [row?.PERSONAL_MOBILE, row?.WORK_PHONE, row?.PERSONAL_PHONE]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return {
    id,
    firstName,
    lastName,
    fullName: [firstName, lastName].filter(Boolean).join(' ') || `Bitrix user ${id}`,
    email: String(row?.EMAIL || '').trim(),
    position: String(row?.WORK_POSITION || '').trim(),
    phones,
    // Bitrix sends true/false or "Y"/"N" depending on the portal version.
    active: row?.ACTIVE === false || row?.ACTIVE === 'N' ? false : true,
  };
}

/** Host only — never the webhook path, which is the credential. */
function webhookHost() {
  try {
    return new URL(normalizeWebhookBase(config.bitrix24WebhookUrl)).host;
  } catch {
    return '';
  }
}

/**
 * Every user in the portal the webhook can see.
 * Returns { ok, users, total, reason, detail } — never throws for a REST or
 * network failure, because both callers report rather than crash.
 */
async function fetchBitrixUsers({ fetchImpl = fetch } = {}) {
  if (!isBitrixConfigured()) {
    return { ok: false, users: [], total: 0, reason: 'not_configured' };
  }

  const base = normalizeWebhookBase(config.bitrix24WebhookUrl);
  const users = [];
  let start = 0;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    let body;
    try {
      const response = await fetchImpl(`${base}user.get.json?start=${start}`);
      body = await response.json().catch(() => ({}));
      if (!response.ok && !body?.error) {
        return {
          ok: false, users: [], total: 0,
          reason: 'request_failed', detail: `HTTP ${response.status}`,
        };
      }
    } catch (err) {
      return { ok: false, users: [], total: 0, reason: 'request_failed', detail: err.message };
    }

    if (body?.error) {
      const code = String(body.error).toUpperCase();
      return {
        ok: false, users: [], total: 0,
        reason: SCOPE_ERRORS.has(code) ? 'no_user_scope' : 'rest_error',
        detail: body.error_description || body.error,
      };
    }

    const rows = Array.isArray(body?.result) ? body.result : [];
    for (const row of rows) {
      const user = normalizeBitrixUser(row);
      if (user) users.push(user);
    }

    const next = Number(body?.next);
    if (!rows.length || !Number.isFinite(next) || next <= start) break;
    start = next;
  }

  return { ok: true, users, total: users.length, reason: null };
}

/**
 * Look up ONE Bitrix user by id — the "is this id a real person?" check behind
 * the per-recruiter button.
 *
 * Returns { ok, user, reason, detail }. `ok:false` means the lookup could not
 * run (bad id, not configured, no user scope, network); `ok:true` with a null
 * `user` means it ran and nobody in the portal has that id. Like the directory
 * read it never throws, because the caller reports rather than crashes.
 *
 * Needs the same `user` scope as the directory: a CRM-only webhook answers
 * ACCESS_DENIED, surfaced as `no_user_scope`.
 */
async function fetchBitrixUserById(bitrixId, { fetchImpl = fetch } = {}) {
  const id = Number.parseInt(bitrixId, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, user: null, reason: 'invalid_id' };
  }
  if (!isBitrixConfigured()) {
    return { ok: false, user: null, reason: 'not_configured' };
  }

  const base = normalizeWebhookBase(config.bitrix24WebhookUrl);
  let body;
  try {
    const response = await fetchImpl(`${base}user.get.json?ID=${id}`);
    body = await response.json().catch(() => ({}));
    if (!response.ok && !body?.error) {
      return { ok: false, user: null, reason: 'request_failed', detail: `HTTP ${response.status}` };
    }
  } catch (err) {
    return { ok: false, user: null, reason: 'request_failed', detail: err.message };
  }

  if (body?.error) {
    const code = String(body.error).toUpperCase();
    return {
      ok: false, user: null,
      reason: SCOPE_ERRORS.has(code) ? 'no_user_scope' : 'rest_error',
      detail: body.error_description || body.error,
    };
  }

  const rows = Array.isArray(body?.result) ? body.result : [];
  const user = rows.map(normalizeBitrixUser).find(Boolean) || null;
  return { ok: true, user, reason: user ? null : 'not_found' };
}

module.exports = {
  MAX_PAGES,
  SCOPE_ERRORS,
  normalizeBitrixUser,
  webhookHost,
  fetchBitrixUsers,
  fetchBitrixUserById,
};
