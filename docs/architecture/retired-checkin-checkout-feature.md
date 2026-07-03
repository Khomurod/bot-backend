# Retired: Pickup/Delivery "Checked In / Checked Out" Location Monitor

**Status:** RETIRED (removed 2026-07) · **Repo:** `bot-backend`

## Why

The driver **Location Monitor** feature watched each active load's live GPS,
and when the truck entered a shipper/receiver check-in radius it posted a
Telegram message to the driver group with **✅ Checked In** / **🚪 Checked Out**
inline buttons (plus nearby pickup/delivery location text). It malfunctioned
often and irritated drivers, so it was retired. **No other feature depended on
it** — it was a *consumer* of shared GPS/Datatruck/ETA helpers, never a provider.

## What this feature was (callback data: `loccheck:in:<id>` / `loccheck:out:<id>`)

1. `services/driverLocationMonitorService.js` — the background poller. Started
   from `index.js`; resolved the active load, decided pickup vs delivery, tracked
   ETA, and **sent the check-in prompt with the two buttons** when the truck was
   within the radius.
2. `bot/locationCheckinHandlers.js` — the Telegram callback handlers for the two
   buttons (recorded arrival/departure, on-time, dwell).
3. `server/routes/locationMonitorRoutes.js` — admin API `/api/location-monitor`
   (per-group enable/config + check-in history).
4. `admin/src/pages/LocationMonitorPage.jsx` + nav item "📡 Location Monitor" —
   admin UI.
5. `database/driverLocationMonitors.js` — DB helpers for the two tables.
6. `config/config.js` `driverLocationMonitorEnabled` (env
   `DRIVER_LOCATION_MONITOR_ENABLED`) — the on/off flag.

### Files / routes / functions / jobs / callbacks / tables found

| Kind | Item |
|---|---|
| Scheduled job / poller | `driverLocationMonitorService.tickDriverLocationMonitors` (interval loop, started in `index.js`) |
| Telegram send | `driverLocationMonitorService.js` builds `loccheck:in`/`loccheck:out` buttons (~lines 280-281) |
| Telegram callbacks | `bot.action(/^loccheck:(in|out):(\d+)$/)` in `bot/locationCheckinHandlers.js` |
| Admin API routes | `GET/PUT /api/location-monitor`, `PUT /api/location-monitor/toggle-all`, `GET /api/location-monitor/:groupId/checkins` |
| Admin API client | `getLocationMonitors`, `updateLocationMonitor`, `updateAllLocationMonitors`, `getLocationCheckins` in `admin/src/api.js` |
| Admin UI | `admin/src/pages/LocationMonitorPage.jsx`; `App.jsx` page + nav entries |
| Config | `config/config.js` `driverLocationMonitorEnabled` |
| DB tables | `driver_location_monitors`, `driver_location_checkins` |
| Tests | `tests/driverLocationMonitor.test.js` |
| Historical label map (KEPT) | `admin/src/pages/UsersPage.jsx` maps `loccheck:in`/`loccheck:out` → "Checked In/Out" for displaying past button taps |

## What will be REMOVED (stops the feature completely)

- **Delete** the poller `services/driverLocationMonitorService.js` and its wiring
  in `index.js` (require, `configureDriverLocationTelegram`,
  `startDriverLocationMonitorService`, `stopDriverLocationMonitorService`).
  → no more check-in prompts are ever generated.
- **Delete** the admin API route file `server/routes/locationMonitorRoutes.js`
  and its mount in `server/api.js`.
- **Delete** the admin UI `admin/src/pages/LocationMonitorPage.jsx`, its `App.jsx`
  page + nav entries, and the 4 client functions in `admin/src/api.js`.
- **Delete** the orphaned DB helper `database/driverLocationMonitors.js` (only
  this feature used it; zero importers remain).
- **Remove** the dead `driverLocationMonitorEnabled` config flag.
- **Delete** the feature test `tests/driverLocationMonitor.test.js`.

## What will be DISABLED / RETIRED instead of deleted (safety)

- **`bot/locationCheckinHandlers.js`** is reduced to a tiny **retired stub** that
  still exports `registerLocationCheckinHandlers(bot)` (bot.js wiring unchanged).
  It registers a broad `loccheck:` callback matcher that, when an **old** button
  from an old message is tapped, replies safely:
  *"This check-in/check-out feature has been retired."* — no crash, no DB access,
  no new state. This satisfies the "old clicks must not crash" requirement.

## What will be PRESERVED (do NOT break)

- **DB tables `driver_location_monitors` and `driver_location_checkins` are
  kept** (marked RETIRED in `database/schema.sql`) — historical check-in/dwell
  data is preserved. **No destructive migration.**
- **`database/db.js` is not touched** (per the stability instruction).
- Shared helpers stay: `services/liveLocationResolver.js` (GPS fallback chain),
  `services/samsaraLocationService.js`, `services/driveHosEldService.js`,
  `services/datatruckLoadService.js` / `datatruckApiService.js`,
  `services/etaRoutingService.js`, `services/driverGroupTitle.js`,
  `services/geocoder.js` — all used by Dispatch ETA / GPS / load lookup.
- **Fuel-stop reminders** (`services/fuelStopAlertService.js`) are a **separate**
  feature and are untouched.
- Samsara safety alerts (external `samsara-integration` repo), recruiting/leads,
  RingCentral/Bitrix/Meta, birthdays, mileage bonus, raise approval — untouched.
- `admin/src/pages/UsersPage.jsx` keeps the `loccheck:in/out` label map so any
  historical button-tap rows still render nicely in the Users tab.

## Risks

- **Low.** The feature is self-contained: nothing imports the poller, the route,
  or the DB helper except the feature's own wiring. Shared services are only
  *consumed* by it, so removing it cannot break them.
- The only behavioral change for drivers is the intended one: no more check-in
  prompts. A late tap on an old button now gets a friendly "retired" reply.
- The `driver_location_monitors.group_id → groups(id) ON DELETE CASCADE` FK is
  untouched; keeping the tables has no effect on the live `groups` table.

## Test plan

1. `node --test --test-concurrency=1 tests/*.test.js` — full suite passes.
2. New `tests/locationCheckinRetired.test.js` — old `loccheck:in:*` /
   `loccheck:out:*` taps invoke `answerCbQuery` with the retirement message and
   never throw / never touch the DB.
3. `npm run build --prefix admin` — admin panel builds without the removed page.
4. `require('./server/api.js')` and `require('./bot/bot.js')` load cleanly (no
   dangling references to the removed modules).
5. Manual/staging: confirm no new check-in messages are sent; confirm dispatch
   `/status` `/location` `/load`, GPS lookup, Datatruck load lookup, fuel-stop
   reminders, and Samsara alerts all still work.
