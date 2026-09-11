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
 * COUNTS AND TIMESTAMPS ONLY. No driver, no chat, no key, no finding title, no
 * operator-typed name (a provider is its catalogue key or "custom"). A
 * provider's last listing error is reduced to its status and a kind from a
 * closed vocabulary (a `credential` says the key is dead); its text never
 * leaves, because the text is the provider's. Anything that fails reads as
 * `available: false` with the reason — this must never make the health
 * endpoint itself unhealthy, which is what Render restarts on.
 */
const defaultDeps = () => ({
  /* eslint-disable global-require */
  consistency: require('./consistencyService'),
  findings: require('../../database/operationalFindings'),
  people: require('../../database/driverPeople'),
  integrity: require('../../database/homeTime/integrity'),
  homeTimeHealth: require('./homeTimeHealth'),
  loads: require('../../database/loadLifecycle'),
  safety: require('../../database/driverSafety'),
  aiProviders: require('../../database/aiProviders'),
  systemHealth: require('../../database/systemHealth'),
  learning: require('../../database/operationalLearning'),
  retention: require('../../database/retentionAssessments'),
  /* eslint-enable global-require */
});

const { FAILURE, classifyFailure } = require('../../lib/ai/classify');
const { getCatalogEntry } = require('../../lib/ai/providerCatalog');

/**
 * A provider's PUBLIC name is its catalogue key, or "custom". `provider_key`
 * is operator-typed text: production once held a disabled row whose key was a
 * pasted API secret, and the first version of this block published it. Only a
 * name the catalogue itself defines can leave; every other row is "custom".
 */
function publicProviderName(p) {
  const entry = getCatalogEntry(p.catalogKey || p.providerKey);
  return entry && entry.key !== 'custom' ? entry.key : 'custom';
}

/**
 * A provider's error text is the PROVIDER's, and /api/health is public. A body
 * can echo the key it was sent, an `authorization:` line, an `"api_key":"…"`
 * field — in any spelling a pattern list would have to guess at. So none of
 * the text leaves. What does is derived from it: the HTTP status it began with
 * and a word from the router's own closed vocabulary (`lib/ai/classify.js`),
 * plus one of ours for discovery that never reached the network. That is
 * enough to see WHY — `credential` says the key is dead; `not_configured` says
 * discovery has nowhere to look — and nothing in it was written by a provider.
 */
const NOT_CONFIGURED = 'not_configured';
const REFRESH_ERROR_KINDS = Object.freeze([...Object.values(FAILURE), NOT_CONFIGURED]);
const NOT_CONFIGURED_TEXT = /^No (Base URL|API key) to list models/i;

function describeRefreshError(text) {
  if (!text) return null;
  const message = String(text);
  if (NOT_CONFIGURED_TEXT.test(message)) return { status: null, kind: NOT_CONFIGURED };
  const lead = message.match(/^(\d{3})\b/);
  const status = lead ? Number(lead[1]) : null;
  return { status, kind: classifyFailure({ status, message }).kind };
}

function summariseCorrections(lastCorrections) {
  if (!lastCorrections) return null;
  const s = lastCorrections.summary || null;
  return {
    at: lastCorrections.at || null,
    applied: s?.applied ?? null,
    stale: s?.stale ?? null,
    failed: s?.failed ?? null,
    // Which check stopped itself and by how much. Check keys are code
    // identifiers; the numbers are counts. Without this a capped pass reads
    // "0 applied" with no why.
    capped: Array.isArray(s?.capped)
      ? s.capped.map((c) => ({ checkKey: c.checkKey, wanted: c.wanted ?? null, cap: c.cap ?? null }))
      : (s?.capped ?? null),
    error: lastCorrections.error || null,
  };
}

async function getOperationsHealth(deps = defaultDeps()) {
  try {
    const status = deps.consistency.getConsistencyStatus();
    const [
      findings, coverage, duplicates, indexPresent, providers, homeTimeLive,
      loadPhases, safety, systems, learning, retention,
    ] = await Promise.all([
      deps.findings.summariseFindings(),
      deps.people.summariseIdentityCoverage(),
      deps.integrity.countDuplicateOpenStays(),
      deps.integrity.indexExists(),
      deps.aiProviders.listProvidersForAdmin(),
      deps.homeTimeHealth.getHomeTimeHealth(),
      deps.loads.summariseLoadPhases().catch(() => null),
      deps.safety.summariseSafety().catch(() => null),
      deps.systemHealth.summariseHealthStates().catch(() => null),
      deps.learning.summariseSuggestions().catch(() => null),
      deps.retention.summariseRetention().catch(() => null),
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
        // What the feature is DOING, not only whether its invariant holds.
        ...homeTimeLive,
      },
      // What every active load is doing, so the lifecycle engine is checkable
      // on a running instance rather than only in its tests.
      loads: loadPhases,
      // Safety as a PATTERN: how many events, of what kind, and how much
      // coaching actually reached a driver.
      safety,
      // WHICH PARTS OF WENZE ARE WORKING, and which have never been looked at —
      // counted separately, because "not checked" and "fine" are different
      // answers and only one of them is reassuring.
      systems,
      // Proposals about Wenze's own rules that are waiting for a person. None
      // of them has changed anything; that is what `proposed` means.
      learning,
      // Drivers the company may be about to lose. A number here that stays high
      // is the feature working and nobody acting on it.
      retention,
      aiModels: providers.map((p) => ({
        provider: publicProviderName(p),
        enabled: p.enabled === true,
        chain: Array.isArray(p.modelChain) ? p.modelChain.length : null,
        discovered: Array.isArray(p.discoveredModels) ? p.discoveredModels.length : 0,
        refreshedAt: p.modelsRefreshedAt || null,
        refreshError: describeRefreshError(p.modelsRefreshError),
      })),
    };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

module.exports = { getOperationsHealth, describeRefreshError, REFRESH_ERROR_KINDS };
