# Route Control, and what is left of it

**Retired:** 2026-10, at the owner's request · **Pre-removal commit:**
`48c548342c9dc69b969bbdba5af833da6f0dc353`

Route Control let a dispatcher paste a Google Maps directions link into a
driver's Telegram group. Wenze parsed the link, computed the route with the
Google Routes API, posted a route message (optionally with a screenshot), then
watched the truck's GPS against the route: an off-route warning in the driver
group, and the route marked complete near the destination.

## What was removed

| | |
|---|---|
| `bot/routeControlHandlers.js` | listening for route links in driver groups, and the Replace / Ignore buttons |
| `services/routeControlService.js`, `services/routeControl/*` | assignment, geometry, the monitor (off-route warnings, auto-completion, destination repair), screenshot delivery, message edits |
| `services/routeMessageDetection.js`, `services/googleMapsUrlParser.js`, `services/routeGeometry.js`, `services/telegramEdit.js`, `services/googleMapsClient.js` | used by nothing else |
| `database/routeControl.js` + `database/routeControl/*`, `database/gmapsSettings.js` | the queries |
| `server/routes/routeControlRoutes.js` (`/api/route-control/*`), `server/routes/routeScreenshotMediaRoutes.js` (`/api/route-screenshot-media/:id`), `server/routes/settings/gmapsRoutes.js` (`/api/settings/gmaps*`) | removed endpoints answer 404 |
| `getRouteMediaEditClient` in `services/telegramAgent.js` | the dedicated media-edit Telegram client |
| `lib/routeControl/routeControlConstants.js` | thresholds and the `ROUTE_CONTROL_ADMIN_*` allow-list |
| Admin: the Route Control page (`#route_control`), Settings → GMaps, `api/routeControl.js`, the screenshot paste helpers | |
| Background service `route_control` (the monitor) and the check `route_control.assignment_on_inactive_group` | the check key is listed in `services/operations/checks/retired.js` so a sweep resolves any finding still open under it |

## What stayed, and why

- **Google Maps for ETA.** `services/etaRoutingService.js` uses
  `GOOGLE_MAPS_API_KEY` from the environment, never the GMaps settings row, so
  Live Locations is untouched (the driver ETA updates were too, until their own
  removal on 2026-10-23 — `retired-dispatch-eta.md`).
- **`admin/src/pages/routeControlGroupSearch.mjs`** stayed while the
  driver-raise panel imported its `driverTypeLabel`; it went with that page
  ([`retired-driver-raise.md`](retired-driver-raise.md)).
- **The tables** `route_assignments`, `route_assignment_attachments`,
  `route_monitor_events` and `gmaps_settings` stay on a deployed database, with
  their rows, until an administrator drops them from **Settings → Retired
  feature leftovers** (group `route_control`) after a backup. The baseline no
  longer creates them (`database/baseline/019_gmaps_and_route_control.sql`), so a
  drop stays done. Migration 0026 still alters `route_assignments`, so a
  BRAND-NEW database — and only that, before its migration ledger exists — gets
  a two-column stub of it for its first boot.
- **Old Telegram buttons.** A Replace / Ignore button on an old route message is
  acknowledged by the `callback_query` catch-all in
  `bot/handlers/surveyCallbackHandlers.js` and does nothing.

`tests/removedFeaturesStayRemoved.test.js` fails if any of it comes back.
