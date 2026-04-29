const config = require('../config/config');
const { getLiveLocationForGroupTitle } = require('./samsaraLocationService');
const { getLiveLocationForGroupTitleFromEvo } = require('./evoEldService');
const { getLiveLocationForGroupTitleFromTt } = require('./ttEldService');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientLocationProviderError(err) {
  const status = Number(err?.status || 0);
  const message = String(err?.message || '').toLowerCase();
  const code = String(err?.code || '');
  if (status === 429 || status === 502 || status === 503 || status >= 500) return true;
  if (['SAMSARA_TIMEOUT', 'EVO_TIMEOUT', 'TT_TIMEOUT'].includes(code)) return true;
  if (message.includes(' 502') || message.includes(' 503') || message.includes('timeout')) return true;
  return false;
}

async function withTransientRetries(label, fn, maxAttempts = 2) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !isTransientLocationProviderError(err)) {
        throw err;
      }
      const delayMs = 400 * attempt;
      console.warn(`[LOCATION] ${label} transient failure (attempt ${attempt}/${maxAttempts}): ${err.message}`);
      await sleep(delayMs);
    }
  }
  throw lastError || new Error(`${label} failed`);
}

async function resolveLiveLocationForGroupTitle(groupTitle) {
  let location = null;
  let source = 'Samsara';
  let samsaraError = null;
  let evoError = null;
  const samsaraKeys = Array.from(
    new Set([
      ...(Array.isArray(config.samsaraApiKeys) ? config.samsaraApiKeys : []),
      config.samsaraApiKey,
    ].filter(Boolean))
  );

  for (const samsaraKey of samsaraKeys) {
    try {
      location = await withTransientRetries('Samsara', () => getLiveLocationForGroupTitle({
        groupTitle,
        apiKey: samsaraKey,
        apiBase: config.samsaraApiBase,
      }));
      if (location) {
        source = 'Samsara';
        break;
      }
    } catch (err) {
      samsaraError = err;
      if (err.code === 'UNIT_NOT_FOUND_IN_GROUP_TITLE') {
        throw err;
      }
    }
  }

  if (!location && !samsaraError) {
    samsaraError = new Error('SAMSARA_API_KEY is not configured.');
  }

  if (!location) {
    try {
      location = await withTransientRetries('EVO ELD', () => getLiveLocationForGroupTitleFromEvo({
        groupTitle,
        usdotNumber: config.evoEldUsdotNumber,
        apiKey: config.evoEldApiKey,
        providerToken: config.evoEldProviderToken,
        apiBase: config.evoEldApiBase,
      }));
      source = 'EVO ELD (fallback)';
    } catch (err) {
      evoError = err;
    }
  }

  if (!location) {
    const ttApiKeys = Array.from(new Set([config.ttEldApiKey, config.evoEldApiKey].filter(Boolean)));
    let ttError = null;

    for (const ttApiKey of ttApiKeys) {
      try {
        location = await withTransientRetries('TT ELD', () => getLiveLocationForGroupTitleFromTt({
          groupTitle,
          usdotNumber: config.ttEldUsdotNumber,
          apiKey: ttApiKey,
          providerToken: config.ttEldProviderToken,
          apiBase: config.ttEldApiBase,
        }));
        source = 'TT ELD (fallback)';
        break;
      } catch (err) {
        ttError = err;
      }
    }

    if (!location) {
      const errors = [samsaraError, evoError, ttError].filter(Boolean);
      const detail = errors.map((err) => err.message).join(' | ');
      const failure = new Error(
        detail || 'Could not fetch live location from Samsara, EVO ELD, or TT ELD right now.'
      );
      failure.code = errors[0]?.code || 'LOCATION_PROVIDER_FAILED';
      throw failure;
    }
  }

  return { location, source };
}

module.exports = {
  resolveLiveLocationForGroupTitle,
};
