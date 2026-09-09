/**
 * Who Wenze may ask right now — settings and providers, cached briefly.
 *
 * The seam this exists to provide: `groqClient` and `geminiClient` read their
 * keys into module-level constants at REQUIRE time, so no database setting
 * could ever take effect without a restart. Everything routed through here
 * picks up a change within the cache window instead.
 *
 * A 30-second cache, the same as every other settings module in this
 * repository. The router reads this on every call and hitting Postgres for a
 * config row each time would be silly; thirty seconds is also short enough that
 * an operator who disables a provider sees it take effect while they are still
 * looking at the page.
 *
 * WHEN THE DATABASE IS UNREACHABLE this answers "AI is off" rather than
 * throwing. Every consumer has a deterministic path or an explicit failure it
 * already handles; a registry that threw would turn a database blip into a
 * different, worse failure inside twenty-odd features.
 */
const aiSettings = require('../../database/aiSettings');
const aiProviders = require('../../database/aiProviders');

const CACHE_TTL_MS = 30_000;
let cache = null;
let cacheExpiresAt = 0;
/** Rotated per call in round-robin mode; process-local by design. */
let rotation = 0;

function invalidateRegistry() {
  cache = null;
  cacheExpiresAt = 0;
  aiSettings.invalidateCache();
}

/**
 * @returns {Promise<{settings: object, providers: Array, available: boolean}>}
 *   `available` false means: do not attempt an AI call at all.
 */
async function getRoster({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now < cacheExpiresAt) return cache;
  try {
    const [settings, providers] = await Promise.all([
      aiSettings.getAiSettings(),
      aiProviders.getProvidersForRouter(),
    ]);
    cache = {
      settings,
      providers,
      // A provider with no key at all is not a provider. Filtering here rather
      // than in the router keeps "unusable" and "cooled down" from looking the
      // same in the logs.
      available: settings.enabled === true && providers.some((p) => Boolean(p.apiKey)),
    };
  } catch (err) {
    console.warn('[AI ROUTER] Roster unavailable, treating AI as off:', err.message);
    cache = { settings: aiSettings.DEFAULTS, providers: [], available: false };
  }
  cacheExpiresAt = now + CACHE_TTL_MS;
  return cache;
}

function nextRotation() {
  rotation = (rotation + 1) % 1_000_000;
  return rotation;
}

module.exports = { CACHE_TTL_MS, getRoster, invalidateRegistry, nextRotation };
