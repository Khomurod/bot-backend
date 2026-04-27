/**
 * Standalone diagnostic: verify EVO ELD unit payload shape.
 * Run from repo root: node scratch/test-evo-api.js
 *
 * Required env vars:
 *   - USDOT_NUMBER
 *   - EVO_ELD_PROVIDER_TOKEN
 */
require('dotenv').config();

const EVO_ELD_API_KEY = 'y9ss8gj4zey7p493f11cfk7085vb0da1t7611h9a3ea';
const EVO_ELD_BASE_URL = 'https://read.evoeld.com/api/v2';
const REQUEST_TIMEOUT_MS = 20_000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    console.error(`[EVO TEST] Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return String(value).trim();
}

async function fetchUnitsByUsdot(usdotNumber, providerToken) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${EVO_ELD_BASE_URL}/units-by-usdot/${encodeURIComponent(usdotNumber)}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'x-api-key': EVO_ELD_API_KEY,
          'provider-token': providerToken,
        },
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`EVO ELD API ${response.status}: ${errorText.slice(0, 500)}`);
    }

    return response.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`EVO ELD API request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

(async () => {
  const usdotNumber = requireEnv('USDOT_NUMBER');
  const providerToken = requireEnv('EVO_ELD_PROVIDER_TOKEN');

  console.log(`[EVO TEST] Requesting units for USDOT ${usdotNumber}...`);

  const payload = await fetchUnitsByUsdot(usdotNumber, providerToken);
  const units = Array.isArray(payload?.units)
    ? payload.units
    : Array.isArray(payload)
      ? payload
      : null;

  if (!units) {
    console.error('[EVO TEST] Unexpected response shape. Full payload:');
    console.log(JSON.stringify(payload, null, 2));
    process.exit(1);
  }

  console.log(`[EVO TEST] Received ${units.length} unit(s).`);

  if (units.length === 0) {
    console.error('[EVO TEST] No units were returned for this USDOT number.');
    console.log(JSON.stringify(payload, null, 2));
    process.exit(1);
  }

  console.log('[EVO TEST] First unit payload:');
  console.log(JSON.stringify(units[0], null, 2));
})().catch((err) => {
  console.error('[EVO TEST] Request failed:', err.message);
  process.exit(1);
});
