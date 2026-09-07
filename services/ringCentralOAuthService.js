'use strict';

/**
 * RingCentral OAuth for RECRUITERS — one access token per recruiter, on demand.
 *
 * WHY THIS EXISTS. RingCentral will not send an SMS whose `from` is another
 * extension's number: not with an admin token, not with a super-admin token,
 * not with a JWT. So texting a lead from the assigned recruiter's own number
 * requires a credential that represents THAT recruiter. Two shapes are
 * supported, and this module is the only place that turns either into a usable
 * bearer token:
 *
 *   'oauth' — an authorization-code refresh token the recruiter produced by
 *             logging in at /ringcentral/connect. Preferred: no human ever
 *             handles the secret.
 *   'jwt'   — a JWT an admin pasted into the Recruiters tab. The original path,
 *             still fully supported; delegated to ringCentralCallService so
 *             there is exactly one JWT implementation.
 *
 * ROTATION IS NOT OPTIONAL. A refresh grant returns a NEW refresh token and
 * invalidates the one used. Dropping it "works" for one refresh and then locks
 * the recruiter out ~7 days later, silently, with leads quietly falling back to
 * the shared number. Every successful refresh here persists the new token
 * before the access token is handed out.
 *
 * Access tokens are cached in memory per recruiter until shortly before expiry;
 * the cache is keyed by recruiter id and dropped whenever the stored credential
 * changes, so a re-login takes effect immediately.
 */
const rc = require('../database/ringcentral');
const { getAccessToken: getJwtAccessToken } = require('./ringCentralCallService');

const REQUEST_TIMEOUT_MS = 25_000;
/** Renew this long before expiry so an in-flight send never uses a dead token. */
const TOKEN_SKEW_SECONDS = 60;

/**
 * recruiterId → { accessToken, expiresAt } (epoch seconds).
 *
 * KEYED BY RECRUITER, NOT BY THE CREDENTIAL, and that is load-bearing: callers
 * hold a `recruiters` row they loaded earlier, so after a rotation their row's
 * refresh token is stale. A cache keyed by the credential would miss for them
 * and send that spent token back to RingCentral, which is exactly the
 * `invalid_grant` this module exists to avoid.
 *
 * The cost of id-keying is that a genuine RE-AUTHORIZATION (a recruiter signing
 * in again, most importantly to correct a sign-in for the wrong RingCentral
 * account) must invalidate explicitly, or every send would keep using the
 * previous account's access token until it expired and be rejected. Both
 * writers of a new login call clearRecruiterTokenCache(): the connect flow and
 * the admin "forget sign-in" route.
 */
const tokenCache = new Map();

function clearRecruiterTokenCache(recruiterId = null) {
  if (recruiterId === null) tokenCache.clear();
  else tokenCache.delete(recruiterId);
}

/**
 * recruiterId → the refresh already in flight for them.
 *
 * A refresh grant ROTATES: it returns a new refresh token and invalidates the
 * one it was called with. So two callers refreshing the same recruiter at once
 * do not merely duplicate work — the second presents a token the first has
 * already spent, gets `invalid_grant`, and marks a perfectly healthy recruiter
 * as needing to sign in again. That race is not hypothetical: the call-log sync
 * and the daily refresh job both start at boot, and two leads can be assigned
 * to the same recruiter seconds apart. Concurrent callers await the SAME grant.
 */
const inFlightRefreshes = new Map();

function authError(message, code, status = null) {
  const err = new Error(message);
  err.code = code;
  if (status !== null) err.status = status;
  return err;
}

/**
 * The one redirect URI the RingCentral app must have registered. It has to be
 * byte-identical here and in the developer console or the authorization is
 * rejected, so it is derived in a single place.
 */
function buildRedirectUri(publicBaseUrl) {
  const base = String(publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw authError('RENDER_EXTERNAL_URL is not configured', 'RC_NO_PUBLIC_URL');
  return `${base}/ringcentral/oauth/callback`;
}

function buildAuthorizeUrl({ apiBase, clientId, redirectUri, state }) {
  if (!clientId) throw authError('RingCentral Client ID is not configured', 'RC_NOT_CONFIGURED');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  const base = String(apiBase || 'https://platform.ringcentral.com').replace(/\/+$/, '');
  return `${base}/restapi/oauth/authorize?${params.toString()}`;
}

/** POST the OAuth token endpoint with HTTP Basic client authentication. */
async function postTokenRequest({ apiBase, clientId, clientSecret, body }) {
  if (!clientId || !clientSecret) {
    throw authError('RingCentral Client ID/Secret are not configured', 'RC_NOT_CONFIGURED');
  }
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${String(apiBase).replace(/\/+$/, '')}/restapi/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result?.access_token) {
      const detail = result?.error_description || result?.error || `HTTP ${response.status}`;
      // invalid_grant is the one failure a retry cannot fix: the refresh token
      // is expired or revoked and the recruiter has to log in again.
      const expired = result?.error === 'invalid_grant';
      throw authError(
        `RingCentral OAuth failed (${response.status}): ${detail}`,
        expired ? 'RC_REFRESH_EXPIRED' : 'RC_AUTH_FAILED',
        response.status,
      );
    }
    return {
      accessToken: result.access_token,
      refreshToken: result.refresh_token || '',
      expiresIn: Number(result.expires_in || 3600),
      ownerId: result.owner_id != null ? String(result.owner_id) : null,
      scope: result.scope || '',
    };
  } catch (err) {
    if (err.name === 'AbortError') throw authError('RingCentral OAuth request timed out', 'RC_TIMEOUT');
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/** Trade the one-time `code` from the callback for a token pair. */
async function exchangeAuthorizationCode({ apiBase, clientId, clientSecret, code, redirectUri }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(code || ''),
    redirect_uri: redirectUri,
  });
  return postTokenRequest({ apiBase, clientId, clientSecret, body });
}

/** Trade a refresh token for a fresh pair. The response's token replaces it. */
async function refreshAccessToken({ apiBase, clientId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: String(refreshToken || ''),
  });
  return postTokenRequest({ apiBase, clientId, clientSecret, body });
}

/**
 * Refresh one recruiter's tokens and persist the rotation.
 *
 * Exposed on its own because the daily refresh job needs exactly this: keep the
 * 7-day window open, and record the failure on the recruiter row when it cannot.
 *
 * @returns {Promise<{accessToken:string, expiresIn:number}>}
 */
function refreshRecruiterTokens(recruiter, auth) {
  const pending = inFlightRefreshes.get(recruiter.id);
  if (pending) return pending;

  const started = performRecruiterRefresh(recruiter, auth)
    .finally(() => { inFlightRefreshes.delete(recruiter.id); });
  inFlightRefreshes.set(recruiter.id, started);
  return started;
}

/** The actual grant. Never call this directly — go through the dedupe above. */
async function performRecruiterRefresh(recruiter, auth) {
  try {
    const tokens = await refreshAccessToken({
      apiBase: auth.apiBase,
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      refreshToken: auth.refreshToken,
    });
    // Persist BEFORE returning: the old refresh token is already dead.
    if (tokens.refreshToken) {
      await rc.updateRecruiterRefreshToken(recruiter.id, tokens.refreshToken);
    }
    // The ONE place the cache is written, so the nightly refresh job warms it
    // for the sends that follow instead of leaving them to refresh again.
    tokenCache.set(recruiter.id, {
      accessToken: tokens.accessToken,
      expiresAt: Math.floor(Date.now() / 1000) + tokens.expiresIn,
    });
    return tokens;
  } catch (err) {
    const note = err.code === 'RC_REFRESH_EXPIRED'
      ? 'RingCentral login expired — this recruiter must connect RingCentral again.'
      : err.message;
    await rc.markRecruiterAuthError(recruiter.id, note).catch(() => {});
    throw err;
  }
}

/**
 * A bearer token that can act as this recruiter, from whichever credential they
 * have. Throws (with a `code`) rather than returning a falsy token, so a caller
 * can never accidentally send from the wrong identity.
 *
 * @param {object} recruiter  a `recruiters` row
 * @param {object} globalCfg  from rc.getRcConfig()
 * @returns {Promise<{accessToken:string, apiBase:string, mode:'oauth'|'jwt'}>}
 */
async function getRecruiterAccessToken(recruiter, globalCfg) {
  if (!recruiter?.id) throw authError('A recruiter row is required', 'RC_NO_RECRUITER');
  const auth = rc.resolveRecruiterRcAuth(recruiter, globalCfg);

  if (auth.mode === 'none') {
    throw authError(
      `${recruiter.name || 'This recruiter'} has no RingCentral credentials of their own.`,
      'RC_NO_RECRUITER_CREDENTIALS',
    );
  }

  if (auth.mode === 'jwt') {
    // ringCentralCallService owns the JWT grant and its own token cache.
    return { accessToken: await getJwtAccessToken(auth), apiBase: auth.apiBase, mode: 'jwt' };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(recruiter.id);
  if (cached && nowSeconds < cached.expiresAt - TOKEN_SKEW_SECONDS) {
    return { accessToken: cached.accessToken, apiBase: auth.apiBase, mode: 'oauth' };
  }

  const tokens = await refreshRecruiterTokens(recruiter, auth);
  return { accessToken: tokens.accessToken, apiBase: auth.apiBase, mode: 'oauth' };
}

module.exports = {
  buildRedirectUri,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  refreshRecruiterTokens,
  getRecruiterAccessToken,
  clearRecruiterTokenCache,
  TOKEN_SKEW_SECONDS,
};
