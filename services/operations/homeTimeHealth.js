/**
 * "Is Home Time actually doing what it was built to do?", answered from
 * outside the application.
 *
 * Phase 4 made three promises that a green test suite cannot verify in
 * production: the return-to-road watcher RUNS (not merely deploys), a manager
 * notice is one per event (not one per background pass), and requests settle
 * as `recorded` (not as `pending` waiting on an approval that no longer
 * exists). Each is a claim about a live database, so each is a number here.
 *
 * Also reports how many AI responsibilities are registered and how many an
 * operator has switched off — the switch is only real if you can see it.
 *
 * COUNTS AND TIMESTAMPS ONLY, because /api/health is public. Anything that
 * throws reads as `available: false` with the reason: this must never make the
 * endpoint unhealthy, which is what Render restarts on.
 */
const defaultDeps = () => ({
  /* eslint-disable global-require */
  observability: require('../../database/homeTime/observability'),
  aiSettings: require('../../database/aiSettings'),
  /* eslint-enable global-require */
});

/** Registered responsibilities, and how many are off. */
async function summariseCapabilities(deps) {
  const rows = await deps.aiSettings.listCapabilities();
  const list = Array.isArray(rows) ? rows : [];
  return {
    registered: list.length,
    switchedOff: list.filter((c) => c.aiEnabled === false).length,
    // The schema CHECKs this to FALSE; reporting it makes the guarantee
    // checkable from outside rather than only in a migration nobody re-reads.
    mayAutoApply: list.filter((c) => c.mayAutoApply === true).length,
  };
}

async function getHomeTimeHealth(deps = defaultDeps()) {
  try {
    const [returnWatch, notices, requests, corrections, capabilities] = await Promise.all([
      deps.observability.summariseReturnWatch(),
      deps.observability.summariseManagerNotices(),
      deps.observability.summariseRequestStatuses(),
      deps.observability.summariseReturnCorrections(),
      summariseCapabilities(deps).catch(() => null),
    ]);
    return {
      available: true,
      returnWatch,
      managerNotices: notices,
      requestsByStatus: requests,
      automaticReturns: corrections,
      aiResponsibilities: capabilities,
    };
  } catch (err) {
    return { available: false, error: err.message };
  }
}

module.exports = { getHomeTimeHealth, summariseCapabilities };
