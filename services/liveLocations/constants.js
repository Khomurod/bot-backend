/**
 * Live Locations tuning constants.
 *
 * The cache TTLs are the cost control for this feature: the dispatch map is
 * polled by every open admin tab, and each miss fans out to Samsara, the ELD
 * providers and Datatruck. Raising a TTL trades freshness for provider calls.
 *
 * Split out of services/liveLocationsService.js, which re-exports the public
 * surface so existing importers are unchanged.
 */

// ─── Tunables ───────────────────────────────────────────────────────────────
const SNAPSHOT_TTL_MS = 45 * 1000;          // GPS freshness window (30–60s)

const ORDERS_TTL_MS = 3 * 60 * 1000;        // Datatruck active-order window cache

const ETA_TTL_MS = 8 * 60 * 1000;           // straight-line ETA cache

const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000; // stop-address coords cache (long)

const ROUTE_TTL_MS = 8 * 60 * 1000;         // selected-unit route cache

const STALE_MINUTES = 15;                    // GPS older than this is "stale"

const LOOKBACK_DAYS = 2;

const LOOKAHEAD_DAYS = 5;

const AVG_SPEED_MPH = 50;                    // straight-line ETA assumption

const ETA_CONCURRENCY = 6;                   // bounded parallel geocodes

module.exports = {
  SNAPSHOT_TTL_MS,
  ORDERS_TTL_MS,
  ETA_TTL_MS,
  GEOCODE_TTL_MS,
  ROUTE_TTL_MS,
  STALE_MINUTES,
  LOOKBACK_DAYS,
  LOOKAHEAD_DAYS,
  AVG_SPEED_MPH,
  ETA_CONCURRENCY,
};
