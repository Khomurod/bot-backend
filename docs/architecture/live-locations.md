# Live Locations (Admin → 📍 Live Locations)

One map for management/dispatch to see every active unit: current location,
heading, active load, next pickup/delivery stop, ETA, and provider status.

- Frontend: `admin/src/pages/LiveLocationsPage.jsx` (Leaflet, imperative)
- Backend service: `services/liveLocationsService.js`
- Backend routes: `server/routes/liveLocationsRoutes.js` (mounted at
  `/api/live-locations`, **admin-auth required** on every route)

The frontend never calls Samsara / Datatruck / ELD / routing providers directly.
The backend collects, normalizes, and caches everything, then serves one clean
snapshot.

---

## Data sources & provider fallback order

### 1. Truck GPS location — Samsara → Factor ELD → Leader ELD
Reuses the existing provider stack; the priority is the same one enforced by
`services/liveLocationResolver.js`.

- **Samsara** via `samsaraLocationService.fetchAllVehicleStats` — uses the newer
  **Vehicle Stats GPS endpoint** (`GET /fleet/vehicles/stats?types=gps`), the
  Samsara-recommended source for telematics GPS.
- **Factor ELD** and **Leader ELD** via
  `driveHosEldService.fetchAllLatestVehicleStatuses` (shared Drive HoS platform;
  a per-carrier company key scopes the data).

**Batching (important):** the snapshot fetches **each provider's entire fleet
once** and matches every unit locally with the exported
`findVehicleByUnit`. It never does one fleet fetch per unit — that would be N×
the API calls and would hit rate limits.

Credentials come from `database/eldSettings.getEldConfig()` (DB row, secrets
encrypted, env-var fallback).

Each unit is normalized to:
```json
{ "lat": 41.1, "lng": -87.1, "heading": 95, "speedMph": 62,
  "lastUpdated": "2026-07-03T12:00:00Z", "isStale": false }
```
`isStale` is `true` when the last GPS ping is older than **15 minutes**. Heading
comes straight from the provider (Samsara `headingDegrees`, Drive HoS
`heading`/`bearing`); it is not recomputed from prior points in this version.

### 2. Active load & next stop — Datatruck (structured API only)
Uses the Datatruck OpenAPI, never Telegram-message parsing.

- One **bulk window fetch** (`datatruckApiService.fetchOrdersByDocumentWindow`,
  −2d … +5d) is done per snapshot, then orders are matched to drivers locally by
  normalized name (`orderDriverCandidates` + `normalizeNameForMatch`). Again: one
  bulk fetch, not one lookup per driver.
- Orders are normalized with `datatruckLoadService.extractLoadFromOrder`.
- **Next stop** = pickup while its appointment window is still upcoming,
  otherwise delivery (`computeNextStop`). Carries stop type, name (shipper /
  receiver), address, and appointment window.
- Datatruck returns addresses but not coordinates, so the next-stop lat/lng is
  filled from the ETA geocode (see below) and cached.

### 3. ETA & route
- **Snapshot ETA (fast, all units):** geocode the next-stop address once
  (long-term cache) via `etaRoutingService.geocodePlace`, then a **straight-line**
  distance (`haversineMiles`) with a 50 mph assumption. `source: "straight-line"`.
  This keeps the snapshot fast and free of per-unit routing calls.
- **Selected-unit route (precise):** `GET /api/live-locations/route?unit=` calls
  `etaRoutingService.calculateEtaToDestination`, whose own fallback chain is
  **OSRM → alternate OSRM → Google Routes API → straight-line**. It returns a
  routed distance/duration plus a simple current→destination line for the map.
- If routing or geocoding fails, ETA is reported as unavailable and the page does
  **not** crash.

---

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/live-locations/snapshot` | Normalized snapshot of all active units (see shape in the task/README). Add `?force=1` to bypass the cache. |
| GET | `/api/live-locations/route?unit=1234` | Precise routed ETA + route geometry for one selected unit (kept out of the snapshot to keep it fast). |
| GET | `/api/live-locations/config` | Map tile provider config (tile URL / attribution). Served to admins only so no map key is baked into the public bundle. |

All three require a valid admin token (`authMiddleware`).

---

## Caching strategy (in-memory, per process)

| Cache | TTL | Notes |
|---|---|---|
| Snapshot | **45 s** | Single-flight: concurrent admin requests share one build, so two admins opening the page do not double the API calls. |
| Datatruck order window | **3 min** | One windowed fetch shared by all units. Reuses the last good set on error. |
| Geocoded stop address → coords | **24 h** | Addresses rarely move; avoids repeat geocoding. |
| Straight-line ETA (per unit + rounded position) | **8 min** | |
| Selected-unit route | **8 min** | |

**On external-API failure:** the affected provider is recorded in the snapshot's
`errors[]` and `summary.providerErrors`; the other providers still populate. If a
whole build throws, the last good snapshot is returned flagged `stale: true`. The
frontend keeps the previous map data on a failed refresh and shows an error
banner.

---

## Map & routing providers used, and why

- **Map: Leaflet** (not Mapbox GL). No Mapbox token is configured in this project,
  and Leaflet lets us avoid baking any map key into the frontend bundle. Tiles
  default to OpenStreetMap (adequate for low-volume internal admin use); set
  `MAP_TILE_URL` / `MAP_TILE_ATTRIBUTION` (e.g. a MapTiler/Mapbox raster URL) to
  upgrade for production scale. The tile URL is delivered by the backend to
  authenticated admins via `/config`, so the key is not in the public bundle.
- **Routing/ETA: existing `etaRoutingService`** (OSRM → Google Routes → straight
  line). Reused rather than adding a new provider; Google Routes/Geocoding keys
  are already configured (`GOOGLE_MAPS_API_KEY`).

---

## Security

- Every route requires admin login; nothing here is public.
- No API keys are exposed to the browser — GPS/load/routing/geocoding all run
  server-side; the tile URL is admin-only.
- Telegram group IDs are returned only to authenticated admins (same as the rest
  of the admin portal).

---

## Storage

- **No GPS history is stored.** This is a live operational view, not a tracking
  log. No new database tables were created.
- All caches are in-memory and bounded by TTL, so there is no growing table and
  no retention job to add.

---

## Known limitations / future work

- Route geometry for the selected unit is a straight current→destination line,
  not a turn-by-turn polyline (`etaRoutingService` requests routes with
  `overview=false`). The routed distance/duration are real; only the drawn line
  is simplified.
- Snapshot ETA is straight-line (fast). The precise routed ETA appears when a
  unit is selected (`/route`).
- Caches are per-process and in-memory. With multiple backend instances each
  keeps its own cache (still well within provider rate limits at current fleet
  size).
- Heading is provider-supplied; it is not recomputed from the previous ping when
  a provider omits it.
