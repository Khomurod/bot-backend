const { getEldConfig } = require('../database/eldSettings');
const { getLiveLocationForGroupTitle } = require('./samsaraLocationService');
const { getLiveLocationForGroupTitleFromDriveHos } = require('./driveHosEldService');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientLocationProviderError(err) {
  const status = Number(err?.status || 0);
  const message = String(err?.message || '').toLowerCase();
  const code = String(err?.code || '');
  if (status === 429 || status === 502 || status === 503 || status >= 500) return true;
  if (['SAMSARA_TIMEOUT', 'DRIVEHOS_TIMEOUT'].includes(code)) return true;
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

/**
 * Resolve a driver's live truck location. Samsara is the primary source; Factor
 * ELD and then Leader ELD (both on the Drive HoS platform) are the fallbacks.
 * Credentials come from the admin Settings tab (eld_settings), falling back to
 * environment variables when unset.
 */
async function resolveLiveLocationForGroupTitle(groupTitle) {
  const cfg = await getEldConfig();
  let location = null;
  let source = 'Samsara';
  const errors = [];

  // ── Primary: Samsara ──
  if (cfg.samsaraEnabled && cfg.samsaraApiKeys.length) {
    for (const samsaraKey of cfg.samsaraApiKeys) {
      try {
        location = await withTransientRetries('Samsara', () => getLiveLocationForGroupTitle({
          groupTitle,
          apiKey: samsaraKey,
          apiBase: cfg.samsaraApiBase,
        }));
        if (location) {
          source = 'Samsara';
          break;
        }
      } catch (err) {
        // A group title we cannot parse will never resolve on any provider.
        if (err.code === 'UNIT_NOT_FOUND_IN_GROUP_TITLE') throw err;
        errors.push(err);
      }
    }
  } else if (cfg.samsaraEnabled) {
    errors.push(new Error('SAMSARA_API_KEY is not configured.'));
  }

  // ── Fallbacks: Factor ELD → Leader ELD (Drive HoS) ──
  const driveHosFallbacks = [
    { label: 'Factor ELD', enabled: cfg.factorEnabled, companyKey: cfg.factorCompanyKey },
    { label: 'Leader ELD', enabled: cfg.leaderEnabled, companyKey: cfg.leaderCompanyKey },
  ];

  for (const provider of driveHosFallbacks) {
    if (location) break;
    if (!provider.enabled || !provider.companyKey) continue;
    try {
      location = await withTransientRetries(provider.label, () => getLiveLocationForGroupTitleFromDriveHos({
        groupTitle,
        providerKey: cfg.driveHosProviderKey,
        companyKey: provider.companyKey,
        apiBase: cfg.driveHosApiBase,
        providerLabel: provider.label,
      }));
      if (location) {
        source = `${provider.label} (fallback)`;
        break;
      }
    } catch (err) {
      if (err.code === 'UNIT_NOT_FOUND_IN_GROUP_TITLE') throw err;
      errors.push(err);
    }
  }

  if (!location) {
    const detail = errors.map((err) => err.message).join(' | ');
    const failure = new Error(
      detail || 'Could not fetch live location from Samsara, Factor ELD, or Leader ELD right now.'
    );
    failure.code = errors[0]?.code || 'LOCATION_PROVIDER_FAILED';
    throw failure;
  }

  return { location, source };
}

module.exports = {
  resolveLiveLocationForGroupTitle,
};
