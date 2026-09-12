'use strict';

/**
 * Dispatcher Board connection — single-row store (id = 1).
 *
 * Backs Settings → Dispatcher Board. The Board is an external Google Apps
 * Script web app that authenticates with a token IN THE QUERY STRING, which is
 * its design and not ours. So:
 *
 *   - the token is stored encrypted (AES-256-GCM, the same scheme as the ELD,
 *     RingCentral and Facebook credentials) and is NEVER returned to the
 *     frontend — the admin read reports only whether one is set, plus a masked
 *     last-4;
 *   - `last_error` is written ONLY through `stripUrls`, so the column that
 *     exists to explain a failure can never become the column that leaks the
 *     credential. A URL in an error message is the normal case here, not an
 *     exotic one: Node quotes the request in its own failures.
 *
 * UNLIKE THE OTHER INTEGRATIONS, there is no environment fallback and `enabled`
 * defaults to FALSE. There is nothing to inherit — no `DISPATCH_BOARD_URL` has
 * ever existed — and an integration that switches itself on at deploy is how
 * unreviewed requests start being made to somebody else's spreadsheet.
 */
const { query } = require('./db');
const { encryptText } = require('../lib/security/facebookCrypto');
const { maskKey, createSafeDecrypt } = require('../lib/security/secretMasking');
const { stripUrls } = require('../lib/security/redactUrls');

const CACHE_TTL_MS = 30_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 300;
const MIN_POLL_INTERVAL_SECONDS = 60;
const MAX_POLL_INTERVAL_SECONDS = 3600;
/** Keep `last_error` a sentence, not a stack trace. */
const MAX_ERROR_CHARS = 500;

let cache = null;
let cacheExpiresAt = 0;

function invalidateCache() {
  cache = null;
  cacheExpiresAt = 0;
}

const safeDecrypt = createSafeDecrypt('[BOARD SETTINGS]', 'the board token');

async function getSettingsRow() {
  try {
    const res = await query('SELECT * FROM dispatch_board_settings WHERE id = 1');
    return res.rows[0] || null;
  } catch (err) {
    console.warn('[BOARD SETTINGS] dispatch_board_settings unavailable:', err.message);
    return null;
  }
}

function clampInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_POLL_INTERVAL_SECONDS;
  return Math.min(MAX_POLL_INTERVAL_SECONDS, Math.max(MIN_POLL_INTERVAL_SECONDS, Math.round(n)));
}

/**
 * A base URL is only usable if it is an absolute http(s) URL. Anything else is
 * treated as "not configured" rather than passed to `fetch` to find out.
 */
function usableBaseUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return text;
  } catch (_) {
    return null;
  }
}

/** Effective, decrypted config for server-side use. Cached for CACHE_TTL_MS. */
async function getBoardConfig() {
  const now = Date.now();
  if (cache && now < cacheExpiresAt) return cache;

  const row = await getSettingsRow();
  const baseUrl = usableBaseUrl(row?.base_url);
  const token = safeDecrypt(row?.token_encrypted) || '';

  const effective = {
    enabled: row ? row.enabled === true : false,
    baseUrl,
    token,
    configured: Boolean(baseUrl && token),
    pollIntervalSeconds: clampInterval(row?.poll_interval_seconds ?? DEFAULT_POLL_INTERVAL_SECONDS),
    lastPollAt: row?.last_poll_at || null,
    lastPollOk: row?.last_poll_ok ?? null,
    lastPollCount: row?.last_poll_count ?? null,
    lastPollBoardDate: row?.last_poll_board_date || null,
    lastPollGeneratedAt: row?.last_poll_generated_at || null,
    lastError: row?.last_error || null,
    updatedAt: row?.updated_at || null,
    updatedBy: row?.updated_by || null,
  };

  cache = effective;
  cacheExpiresAt = now + CACHE_TTL_MS;
  return effective;
}

/** Masked admin view — never returns the token, and never the raw URL's query. */
async function getBoardSettingsForAdmin() {
  const cfg = await getBoardConfig();
  return {
    enabled: cfg.enabled,
    baseUrl: cfg.baseUrl,
    tokenSet: Boolean(cfg.token),
    tokenMasked: maskKey(cfg.token),
    configured: cfg.configured,
    pollIntervalSeconds: cfg.pollIntervalSeconds,
    lastPollAt: cfg.lastPollAt,
    lastPollOk: cfg.lastPollOk,
    lastPollCount: cfg.lastPollCount,
    lastPollBoardDate: cfg.lastPollBoardDate,
    lastPollGeneratedAt: cfg.lastPollGeneratedAt,
    lastError: cfg.lastError,
    updatedAt: cfg.updatedAt,
    updatedBy: cfg.updatedBy,
  };
}

/**
 * Update settings. Omit-means-keep; `clearToken` nulls the credential.
 *
 * The base URL is stored with its query string INTACT if somebody pastes one —
 * an Apps Script `/exec` sometimes carries parameters other than the token —
 * but it is never echoed back anywhere a token could ride along, because the
 * admin read returns it and the token is a separate field by construction.
 */
async function updateBoardSettings(payload = {}, { updatedBy = null } = {}) {
  const sets = [];
  const values = [];
  let i = 1;

  if (typeof payload.enabled === 'boolean') {
    sets.push(`enabled = $${i++}`);
    values.push(payload.enabled);
  }
  if (payload.baseUrl !== undefined) {
    const text = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : '';
    sets.push(`base_url = $${i++}`);
    values.push(text || null);
  }
  if (payload.clearToken) {
    sets.push('token_encrypted = NULL', 'token_last4 = NULL');
  } else if (typeof payload.token === 'string' && payload.token.trim()) {
    const token = payload.token.trim();
    sets.push(`token_encrypted = $${i++}`);
    values.push(encryptText(token));
    sets.push(`token_last4 = $${i++}`);
    values.push(token.slice(-4));
  }
  if (payload.pollIntervalSeconds !== undefined
      && payload.pollIntervalSeconds !== null
      && payload.pollIntervalSeconds !== '') {
    sets.push(`poll_interval_seconds = $${i++}`);
    values.push(clampInterval(payload.pollIntervalSeconds));
  }

  if (!sets.length) {
    invalidateCache();
    return getBoardSettingsForAdmin();
  }
  sets.push(`updated_by = $${i++}`);
  values.push(updatedBy ? String(updatedBy).slice(0, 120) : null);
  sets.push('updated_at = NOW()');
  await query(`UPDATE dispatch_board_settings SET ${sets.join(', ')} WHERE id = 1`, values);
  invalidateCache();
  return getBoardSettingsForAdmin();
}

/**
 * What the last poll did. `error` goes through `stripUrls` HERE rather than at
 * the call site, so there is exactly one place that can get it wrong.
 */
async function recordPollOutcome({
  ok, count = null, boardDate = null, generatedAt = null, error = null,
} = {}) {
  const safeError = error ? stripUrls(error).slice(0, MAX_ERROR_CHARS) : null;
  try {
    await query(
      `UPDATE dispatch_board_settings SET
         last_poll_at = NOW(),
         last_poll_ok = $1,
         last_poll_count = $2,
         last_poll_board_date = $3,
         last_poll_generated_at = $4,
         last_error = $5,
         updated_at = updated_at
       WHERE id = 1`,
      [ok === true, Number.isFinite(Number(count)) ? Math.round(Number(count)) : null,
        boardDate || null, generatedAt || null, safeError]
    );
  } catch (err) {
    console.warn('[BOARD SETTINGS] could not record the poll outcome:', stripUrls(err.message));
  }
  invalidateCache();
  return safeError;
}

module.exports = {
  getBoardConfig,
  getBoardSettingsForAdmin,
  updateBoardSettings,
  recordPollOutcome,
  invalidateCache,
  usableBaseUrl,
  clampInterval,
  DEFAULT_POLL_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  MAX_POLL_INTERVAL_SECONDS,
};
