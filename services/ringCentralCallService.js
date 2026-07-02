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

async function rcGet({ cfg, accessToken, path }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${cfg.apiBase}${path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : {}; } catch (_) { payload = null; }
    if (!response.ok) {
      const msg = payload?.errorCode || payload?.message || text.slice(0, 300) || `HTTP ${response.status}`;
      const err = new Error(`RingCentral ${path} ${response.status}: ${msg}`);
      err.code = 'RC_API_ERROR';
      err.status = response.status;
      throw err;
    }
    return payload || {};
  } catch (err) {
    if (err.name === 'AbortError') {
      const e = new Error('RingCentral request timed out.');
      e.code = 'RC_TIMEOUT';
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Identity of the user the JWT belongs to: extension name/number plus the
 * direct phone numbers on that extension. Used by the per-number Diagnose
 * button to confirm the JWT actually matches the recruiter's assigned number.
 */
async function getExtensionInfo(cfg) {
  const accessToken = await getAccessToken(cfg);
  const ext = await rcGet({ cfg, accessToken, path: '/restapi/v1.0/account/~/extension/~' });
  let phoneNumbers = [];
  try {
    const numbers = await rcGet({
      cfg, accessToken,
      path: '/restapi/v1.0/account/~/extension/~/phone-number?perPage=100',
    });
    phoneNumbers = (numbers.records || [])
      .map((r) => r.phoneNumber)
      .filter(Boolean);
  } catch (err) {
    // Phone-number read may not be granted; the extension identity is enough.
    console.warn('[RC] extension phone-number read failed:', err.message);
  }
  return {
    extensionId: ext?.id != null ? String(ext.id) : null,
    extensionNumber: ext?.extensionNumber || null,
    name: ext?.name || ext?.contact?.firstName || null,
    status: ext?.status || null,
    phoneNumbers,
  };
}

async function fetchCallLogPage({ cfg, accessToken, dateFrom, dateTo, page, scope = 'account' }) {
  const params = new URLSearchParams({
    view: 'Simple',
    type: 'Voice',
    perPage: String(PER_PAGE),
    page: String(page),
    dateFrom,
  });
  if (dateTo) params.set('dateTo', dateTo);

  const basePath = scope === 'extension'
    ? '/restapi/v1.0/account/~/extension/~/call-log'
    : '/restapi/v1.0/account/~/call-log';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${cfg.apiBase}${basePath}?${params.toString()}`,
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

async function fetchAllCallLogPages({ cfg, dateFrom, dateTo, scope }) {
  const accessToken = await getAccessToken(cfg);
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const payload = await fetchCallLogPage({ cfg, accessToken, dateFrom, dateTo, page, scope });
    const records = Array.isArray(payload.records) ? payload.records : [];
    all.push(...records);
    const totalPages = Number(payload?.paging?.totalPages || 0);
    if (!records.length) break;
    if (totalPages && page >= totalPages) break;
    if (records.length < PER_PAGE) break;
  }
  return all;
}

/**
 * Fetch all company-wide Voice call-log records in [dateFrom, dateTo]
 * (ISO 8601 strings). Requires an admin-role JWT with Read Call Log.
 */
async function fetchAccountCallLog({ cfg, dateFrom, dateTo }) {
  return fetchAllCallLogPages({ cfg, dateFrom, dateTo, scope: 'account' });
}

/**
 * Fetch the JWT user's OWN extension call log — the per-number path. Any user
 * can read their own log, so this works without an admin-role JWT.
 */
async function fetchExtensionCallLog({ cfg, dateFrom, dateTo }) {
  return fetchAllCallLogPages({ cfg, dateFrom, dateTo, scope: 'extension' });
}

module.exports = {
  getAccessToken,
  getExtensionInfo,
  fetchAccountCallLog,
  fetchExtensionCallLog,
};
