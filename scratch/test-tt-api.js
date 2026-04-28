/**
 * Standalone diagnostic: verify TT ELD unit payload shape and credentials.
 * Run from repo root:
 *   node scratch/test-tt-api.js
 *
 * Required env vars:
 *   - TT_ELD_API_KEY
 *   - TT_ELD_PROVIDER_TOKEN
 *   - TT_ELD_USDOT_NUMBER (or USDOT_NUMBER)
 *
 * Optional env vars:
 *   - TT_ELD_API_BASE (defaults to https://read.tteld.com)
 *   - TT_ELD_ENDPOINT_PATH (defaults to /api/externalservice/units-by-usdot)
 */
require('dotenv').config();

const REQUEST_TIMEOUT_MS = 20_000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    console.error(`[TT TEST] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return String(value).trim();
}

function getEnv(name, fallback) {
  const value = process.env[name];
  return value && String(value).trim() ? String(value).trim() : fallback;
}

async function fetchUnitsByUsdot({ apiBase, endpointPath, usdotNumber, apiKey, providerToken }) {
  const cleanBase = String(apiBase).replace(/\/+$/, '');
  const cleanPath = String(endpointPath).replace(/\/+$/, '');
  const url = `${cleanBase}${cleanPath}/${encodeURIComponent(usdotNumber)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'x-api-key': apiKey,
        'provider-token': providerToken,
      },
      signal: controller.signal,
    });

    const rawText = await response.text();
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : {};
    } catch (_) {
      payload = null;
    }

    if (!response.ok) {
      const msg = payload?.message || payload?.error?.message || rawText.slice(0, 500) || `HTTP ${response.status}`;
      throw new Error(`TT ELD API ${response.status}: ${msg}`);
    }

    return payload;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`TT ELD API request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function pickUnits(payload) {
  if (Array.isArray(payload?.units)) return payload.units;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  return null;
}

function summarizeUnit(unit) {
  const truckNumber = unit?.truck_number ?? unit?.truckNumber ?? unit?.unit_number ?? unit?.unitNumber ?? null;
  const lat = unit?.coordinates?.lat ?? unit?.coordinates?.latitude ?? unit?.lat ?? unit?.latitude ?? null;
  const lng = unit?.coordinates?.lng ?? unit?.coordinates?.lon ?? unit?.coordinates?.longitude ?? unit?.lng ?? unit?.longitude ?? null;
  const timestamp = unit?.timestamp ?? unit?.time ?? unit?.gpsTime ?? null;

  return {
    truckNumber,
    latitude: lat,
    longitude: lng,
    timestamp,
  };
}

(async () => {
  const apiKey = requireEnv('TT_ELD_API_KEY');
  const providerToken = requireEnv('TT_ELD_PROVIDER_TOKEN');
  const usdotNumber = getEnv('TT_ELD_USDOT_NUMBER', process.env.USDOT_NUMBER ? String(process.env.USDOT_NUMBER).trim() : '');
  if (!usdotNumber) {
    console.error('[TT TEST] Missing required environment variable: TT_ELD_USDOT_NUMBER (or USDOT_NUMBER)');
    process.exit(1);
  }

  const apiBase = getEnv('TT_ELD_API_BASE', 'https://read.tteld.com');
  const endpointPath = getEnv('TT_ELD_ENDPOINT_PATH', '/api/externalservice/units-by-usdot');

  console.log(`[TT TEST] Requesting units for USDOT ${usdotNumber} via ${apiBase}${endpointPath}/:usdot ...`);

  const payload = await fetchUnitsByUsdot({
    apiBase,
    endpointPath,
    usdotNumber,
    apiKey,
    providerToken,
  });

  const units = pickUnits(payload);
  if (!units) {
    console.error('[TT TEST] Unexpected response shape (no units/data array). Full payload:');
    console.log(JSON.stringify(payload, null, 2));
    process.exit(1);
  }

  console.log(`[TT TEST] Received ${units.length} unit(s).`);
  if (!units.length) {
    console.error('[TT TEST] Response is valid but contains no units.');
    console.log(JSON.stringify(payload, null, 2));
    process.exit(1);
  }

  console.log('[TT TEST] First unit (raw):');
  console.log(JSON.stringify(units[0], null, 2));

  console.log('[TT TEST] First unit (field summary):');
  console.log(JSON.stringify(summarizeUnit(units[0]), null, 2));
})().catch((err) => {
  console.error('[TT TEST] Request failed:', err.message);
  process.exit(1);
});
