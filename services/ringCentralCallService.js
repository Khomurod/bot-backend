/**
 * RingCentral Call Log client for recruiter KPIs.
 *
 * Auth: server-side JWT bearer grant (same as ringCentralSmsService), but
 * credentials come from the admin Settings tab (ringcentral_settings) rather
 * than env. We read the company-wide Call Log:
 *   GET /restapi/v1.0/account/~/call-log?view=Simple&type=Voice&dateFrom&dateTo
 * which requires the JWT app to have the "Read Call Log" permission and an
 * admin-role user. Each Simple record has: id, sessionId, startTime, duration,
 * direction (Inbound/Outbound), result, and from/to { phoneNumber }.
 */
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_PAGES = 50;
const PER_PAGE = 1000;

// Token cache keyed by clientId+jwt so switching creds doesn't reuse a token.
const tokenCache = new Map();

async function getAccessToken(cfg) {
  const { clientId, clientSecret, jwtToken, apiBase } = cfg;
  if (!clientId || !clientSecret || !jwtToken) {
    const err = new Error('RingCentral credentials are not configured.');
    err.code = 'RC_NOT_CONFIGURED';
    throw err;
  }

  const cacheKey = `${clientId}:${jwtToken.slice(-12)}`;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(cacheKey);
  if (cached && nowSeconds < cached.expiresAt - 60) return cached.accessToken;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwtToken,
  });
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBase}/restapi/oauth/token`, {
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
      const err = new Error(`RingCentral auth failed (${response.status}): ${result?.error_description || result?.error || JSON.stringify(result).slice(0, 300)}`);
      err.code = 'RC_AUTH_FAILED';
      err.status = response.status;
      throw err;
    }
    tokenCache.set(cacheKey, {
      accessToken: result.access_token,
      expiresAt: nowSeconds + Number(result.expires_in || 3600),
    });
    return result.access_token;
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('RingCentral auth request timed out.');
      e.code = 'RC_TIMEOUT';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCallLogPage({ cfg, accessToken, dateFrom, dateTo, page }) {
  const params = new URLSearchParams({
    view: 'Simple',
    type: 'Voice',
    perPage: String(PER_PAGE),
    page: String(page),
    dateFrom,
  });
  if (dateTo) params.set('dateTo', dateTo);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${cfg.apiBase}/restapi/v1.0/account/~/call-log?${params.toString()}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        signal: controller.signal,
      }
    );
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = null; }
    if (!response.ok) {
      const msg = payload?.errorCode || payload?.message || text.slice(0, 300) || `HTTP ${response.status}`;
      const err = new Error(`RingCentral call-log ${response.status}: ${msg}`);
      err.code = 'RC_CALLLOG_ERROR';
      err.status = response.status;
      throw err;
    }
    return payload || {};
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('RingCentral call-log request timed out.');
      e.code = 'RC_TIMEOUT';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch all Voice call-log records in [dateFrom, dateTo] (ISO 8601 strings).
 * Returns a flat array of raw RingCentral records.
 */
async function fetchAccountCallLog({ cfg, dateFrom, dateTo }) {
  const accessToken = await getAccessToken(cfg);
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const payload = await fetchCallLogPage({ cfg, accessToken, dateFrom, dateTo, page });
    const records = Array.isArray(payload.records) ? payload.records : [];
    all.push(...records);
    const totalPages = Number(payload?.paging?.totalPages || 0);
    if (!records.length) break;
    if (totalPages && page >= totalPages) break;
    if (records.length < PER_PAGE) break;
  }
  return all;
}

module.exports = {
  getAccessToken,
  fetchAccountCallLog,
};
