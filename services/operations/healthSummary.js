/**
 * The operational state of the fleet's OWN records, as numbers, for /api/health.
 *
 * Phase 3 made the system correct itself in the background; this is how anyone
 * — an operator, a deploy check, this repository's own verification — can see
 * that it is happening in production without a database connection or an
 * admin session: how many findings are open, what the last background pass
 * applied, how much of the fleet has a permanent identity, whether any home
 * stay is doubled, whether the one-open-stay index is in, and whether each AI
 * provider's model listing is current.
 *
 * COUNTS AND TIMESTAMPS ONLY. No driver, no chat, no key, no finding title. A
 * provider's last listing error is kept to a short prefix (a "401 …" says the
 * key is dead; nothing in it is the key). Anything that fails reads as
 * `available: false` with the reason — this must never make the health
 * endpoint itself unhealthy, which is what Render restarts on.
 */
const defaultDeps = () => ({
  /* eslint-disable global-require */
  consistency: require('./consistencyService'),
  findings: require('../../database/operationalFindings'),
  people: require('../../database/driverPeople'),
  integrity: require('../../database/homeTime/integrity'),
  aiProviders: require('../../database/aiProviders'),
  /* eslint-enable global-require */
});

const ERROR_PREFIX_CHARS = 120;

/**
 * A provider's error text is the provider's, and /api/health is public. The
 * text is worth showing ("401 Unauthorized" says the key is dead; "404 No Base
 * URL" says discovery has nowhere to look), but nothing shaped like a
 * credential may ride along in it — a key echoed in a body, a `key=` query
 * string, a bearer token, any long opaque token. Scrubbed BEFORE it is cut to
 * length, so a truncated key cannot slip through as a shorter one.
 */
const CREDENTIAL_SHAPES = [
  /\b(key|api[_-]?key|token|secret|authorization)=([^&\s'"]+)/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(AIza|gsk_|sk-|nvapi-|csk-|or-)[A-Za-z0-9._-]{8,}/g,
  /\b[A-Za-z0-9_-]{32,}\b/g,
];

function scrubErrorText(text) {
  let out = String(text);
  out = out.replace(CREDENTIAL_SHAPES[0], (m, name) => `${name}=[redacted]`);
  for (const re of CREDENTIAL_SHAPES.slice(1)) out = out.replace(re, '[redacted]');
  return out.slice(0, ERROR_PREFIX_CHARS);
}

function summariseCorrections(lastCorrections) {
  if (!lastCorrections) return null;
  const s = lastCorrections.summary || null;
  return {
    at: lastCorrections.at || null,
    applied: s?.applied ?? null,
    stale: s?.stale ?? null,
    failed: s?.failed ?? null,
    capped: Array.isArray(s?.capped) ? s.capped.length : (s?.capped ?? null),
    error: lastCorrections.error || null,
  };
}

async function getOperationsHealth(deps = defaultDeps()) {
  try {
    const status = deps.consistency.getConsistencyStatus();
    const [findings, coverage, duplicates, indexPresent, providers] = await Promise.all([
      deps.findings.summariseFindings(),
      deps.people.summariseIdentityCoverage(),
      deps.integrity.countDuplicateOpenStays(),
      deps.integrity.indexExists(),
      deps.aiProviders.listProvidersForAdmin(),
    ]);
    return {
      available: true,
      sweep: {
        running: status.running,
        lastRunAt: status.lastRun?.at || null,
        found: status.lastRun?.summary?.found ?? null,
        filed: status.lastRun?.summary?.filed ?? null,
        resolved: status.lastRun?.summary?.resolved ?? null,
      },
      corrections: summariseCorrections(status.lastCorrections),
      findings,
      identity: coverage,
      homeTime: {
        groupsWithDuplicateOpenStays: duplicates.length,
        openStayIndex: indexPresent ? 'present' : 'absent',
      },
      aiModels: providers.map((p) => ({
        provider: p.providerKey,
        enabled: p.enabled === true,
        chain: Array.isArray(p.modelChain) ? p.modelChain.length : null,
        discovered: Array.isArray(p.discoveredModels) ? p.discoveredModels.length : 0,
        refreshedAt: p.modelsRefreshedAt || null,
        refreshError: p.modelsRefreshError ? scrubErrorText(p.modelsRefreshError) : null,
      })),
    };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

module.exports = { getOperationsHealth, scrubErrorText, ERROR_PREFIX_CHARS };
