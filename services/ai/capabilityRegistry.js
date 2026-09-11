/**
 * Putting the catalogue into the database, so an administrator has something to
 * switch off.
 *
 * `ai_capabilities` was empty in production: `registerCapability` existed and no
 * production code ever called it, so the admin table rendered nothing and the
 * switch it offered would have had no effect anyway. This runs once at boot and
 * fixes the first half of that; `services/ai/capabilityGate.js` fixes the second.
 *
 * IT NEVER OVERWRITES A PERSON'S CHOICE. `registerCapability` updates only the
 * descriptive columns — label, whether the prompt carries message text, whether
 * there is a fallback — and leaves `ai_enabled` exactly as stored. A capability
 * an operator switched off stays off across every deploy, which is the whole
 * point of a switch.
 */
const { CAPABILITIES } = require('../../lib/ai/capabilityCatalog');

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    aiSettings: require('../../database/aiSettings'),
    invalidateCapabilityCache: require('./capabilityGate').invalidateCapabilityCache,
  };
  /* eslint-enable global-require */
}

/**
 * @returns {Promise<{registered:number, failed:number}>} — never throws. A
 *   database that is not ready must not stop the application from booting; the
 *   gate treats an unregistered capability as enabled, so the only cost of a
 *   failed pass is that the switch is missing from the admin until the next one.
 */
async function registerKnownCapabilities(deps = defaultDeps()) {
  const summary = { registered: 0, failed: 0 };
  for (const capability of CAPABILITIES) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await deps.aiSettings.registerCapability(capability.key, {
        label: capability.label,
        sendsRawText: capability.sendsRawText === true,
        hasDeterministicFallback: Boolean(capability.fallback),
      });
      summary.registered += 1;
    } catch (err) {
      summary.failed += 1;
      console.warn(`[AI CAPABILITIES] could not register ${capability.key}:`, err.message);
    }
  }
  try {
    deps.invalidateCapabilityCache();
  } catch (err) { /* the cache simply expires */ }
  if (summary.registered) {
    console.log(`[AI CAPABILITIES] ${summary.registered} AI responsibilities registered`
      + `${summary.failed ? `, ${summary.failed} failed` : ''}.`);
  }
  return summary;
}

module.exports = { registerKnownCapabilities };
