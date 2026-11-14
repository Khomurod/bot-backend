'use strict';

/**
 * "Which providers may do THIS task, in what order?" — read for the router.
 *
 * The rule is lib/ai/providerChoice.js; the stored list is
 * `ai_capabilities.provider_order` (migration 0107), read through the same
 * cached rows as the per-task switch (services/ai/capabilityGate.js), so a
 * save in Settings → AI takes effect at once (the route invalidates that
 * cache).
 *
 * WHEN THE ROW CANNOT BE READ the answer depends on the task, and errs the
 * safe way for each: a task that follows the global order keeps it (an AI
 * call must not fail because a settings read did), and a task that REQUIRES
 * a choice — a candidate's CDL — is asked of nobody.
 */

const { getCapabilityMeta } = require('../../lib/ai/capabilityCatalog');
const { effectiveProviderOrder } = require('../../lib/ai/providerChoice');

/** The gate's cached rows — looked up at call time, so a reloaded gate is the one read. */
function gateRow(capabilityKey) {
  // eslint-disable-next-line global-require
  return require('./capabilityGate').getCapability(capabilityKey);
}

/**
 * @param {string|null} capabilityKey
 * @returns {Promise<string[]|null>} null: the global order; a list: only those, in that order
 */
async function providerOrderFor(capabilityKey, deps = {}) {
  if (!capabilityKey) return null;
  const meta = getCapabilityMeta(capabilityKey);
  try {
    const row = await (deps.getCapability || gateRow)(capabilityKey);
    return effectiveProviderOrder(meta, row?.providerOrder);
  } catch {
    return meta?.providerChoice === 'required' ? [] : null;
  }
}

module.exports = { providerOrderFor };
