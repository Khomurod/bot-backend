/**
 * Who Wenze may ask right now — settings and providers, cached briefly.
 *
 * The seam this exists to provide: `groqClient` and `geminiClient` read their
 * keys into module-level constants at REQUIRE time, so no database setting
 * could ever take effect without a restart. Everything routed through here
 * picks up a change within the cache window instead.
 *
 * A TEN-MINUTE cache. It was thirty seconds, like the other settings modules,
 * until the database's monthly transfer allowance ran short (October 2026): the
 * router reads this on every call, and every read was the whole provider row.
 * Nothing is lost by the longer window, because nothing that changes a provider
 * waits for it — every admin save calls `invalidateRegistry()`, and so does the
 * router itself the moment it puts a provider on cooldown, so a failing
 * provider is not asked again on the strength of a stale roster. A success is
 * applied to the cached row directly (`noteProviderSuccess`), since the
 * cooldown ladder counts consecutive failures.
 *
 * THE MODEL LISTING IS CACHED SEPARATELY, for twelve hours: the ids a provider
 * last listed change only when a refresh or a Connect writes them, and both
 * call `invalidateRegistry()` when they do.
 *
 * WHEN THE DATABASE IS UNREACHABLE this answers "AI is off" rather than
 * throwing. Every consumer has a deterministic path or an explicit failure it
 * already handles; a registry that threw would turn a database blip into a
 * different, worse failure inside twenty-odd features.
 */
const aiSettings = require('../../database/aiSettings');
const aiProviders = require('../../database/aiProviders');

const CACHE_TTL_MS = 10 * 60 * 1000;
const LISTING_TTL_MS = 12 * 60 * 60 * 1000;
// An unreachable database is remembered as "AI is off" for only this long —
// the old thirty seconds — so one blip cannot switch AI off for ten minutes.
const FAILED_READ_TTL_MS = 30 * 1000;
let cache = null;
let cacheExpiresAt = 0;
let listing = null;
let listingExpiresAt = 0;
/** Rotated per call in round-robin mode; process-local by design. */
let rotation = 0;

function invalidateRegistry() {
  cache = null;
  cacheExpiresAt = 0;
  listing = null;
  listingExpiresAt = 0;
  aiSettings.invalidateCache();
}

/**
 * The router's next read sees the provider rows as they are now. For the
 * router's own writes — a cooldown — which change nothing else it caches.
 */
function invalidateProviders() {
  cache = null;
  cacheExpiresAt = 0;
}

/**
 * What `aiProviders.recordSuccess` just wrote, applied to the cached roster so
 * the next failure is counted from zero — not from a count the database has
 * already cleared (the cooldown ladder grows with consecutive failures). Only
 * this provider's entry changes, and only when there is something to clear.
 */
function noteProviderSuccess(providerKey) {
  if (!cache?.providers) return;
  const stale = cache.providers.some((p) => p.providerKey === providerKey
    && ((p.consecutiveFailures || 0) > 0 || p.cooledUntil != null || p.cooldownReason != null));
  if (!stale) return;
  cache = {
    ...cache,
    providers: cache.providers.map((p) => (p.providerKey === providerKey
      ? { ...p, consecutiveFailures: 0, cooledUntil: null, cooldownReason: null }
      : p)),
  };
}

/**
 * provider key → the model ids it last listed, or null when the data module
 * has no listing reader (the tests' stand-ins). A failed read is "unknown" —
 * the router then filters nothing — and is retried at the roster's pace rather
 * than held for twelve hours.
 */
async function getModelListing(now) {
  if (listing && now < listingExpiresAt) return listing;
  if (typeof aiProviders.getDiscoveredModelIdsForRouter !== 'function') return null;
  try {
    listing = await aiProviders.getDiscoveredModelIdsForRouter();
    listingExpiresAt = now + LISTING_TTL_MS;
  } catch (err) {
    console.warn('[AI ROUTER] Model listing unavailable, filtering nothing:', err.message);
    listing = new Map();
    listingExpiresAt = now + CACHE_TTL_MS;
  }
  return listing;
}

/**
 * @returns {Promise<{settings: object, providers: Array, available: boolean}>}
 *   `available` false means: do not attempt an AI call at all.
 */
async function getRoster({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now < cacheExpiresAt) return cache;
  try {
    const [settings, rows, listed] = await Promise.all([
      aiSettings.getAiSettings(),
      aiProviders.getProvidersForRouter(),
      getModelListing(now),
    ]);
    const providers = listed
      ? rows.map((p) => ({ ...p, discoveredModelIds: listed.get(p.providerKey) || [] }))
      : rows;
    cache = {
      settings,
      providers,
      // A provider with no key at all is not a provider. Filtering here rather
      // than in the router keeps "unusable" and "cooled down" from looking the
      // same in the logs.
      available: settings.enabled === true && providers.some((p) => Boolean(p.apiKey)),
    };
    cacheExpiresAt = now + CACHE_TTL_MS;
  } catch (err) {
    console.warn('[AI ROUTER] Roster unavailable, treating AI as off:', err.message);
    cache = { settings: aiSettings.DEFAULTS, providers: [], available: false };
    cacheExpiresAt = now + FAILED_READ_TTL_MS;
  }
  return cache;
}

/**
 * Is there any provider Wenze may ask right now?
 *
 * The seam the nine consumer files needed. They gated on `GROQ_API_KEY` /
 * `GEMINI_API_KEY` truthiness read at REQUIRE time, which was correct while the
 * environment was the only place a key could live. Since Stage 5 a key can live
 * in the database instead — and an operator who moves one there and clears the
 * env var would have silently lost those features, with nothing failing and
 * nothing said. The master switch has the same problem in reverse: turning AI
 * off in the admin left those gates reading "configured".
 *
 * Answers from the roster cache, so a gate on a hot path costs a map
 * lookup rather than a query, and an operator's change takes effect while they
 * are still looking at the page.
 *
 * FALSE WHEN THE DATABASE IS UNREACHABLE, because `getRoster` treats that as
 * "AI is off" — every consumer of this has a deterministic path or an explicit
 * failure it already handles, and a gate that threw would turn a database blip
 * into a different, worse failure inside twenty-odd features.
 */
async function isAiAvailable() {
  const roster = await getRoster();
  return roster.available === true;
}

function nextRotation() {
  rotation = (rotation + 1) % 1_000_000;
  return rotation;
}

module.exports = {
  CACHE_TTL_MS, LISTING_TTL_MS, FAILED_READ_TTL_MS,
  getRoster, invalidateRegistry, invalidateProviders, noteProviderSuccess, nextRotation, isAiAvailable,
};
