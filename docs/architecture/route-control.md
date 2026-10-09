# Route Control — invariants

Read this before changing anything under `services/routeControl/`,
`database/routeControl/`, `database/gmapsSettings.js`,
`lib/routeControl/routeControlConstants.js`, or the route-screenshot endpoints.

`services/routeControlService.js` is a **re-export-only compatibility façade**.
Add new code to a focused module inside `services/routeControl/` and export it
from `services/routeControl/index.js` — never grow the façade.

## Destination auto-completion vs off-route warnings

These are two different features with two different preconditions. Conflating
them is the classic regression here.

| | Auto-completion | Off-route warning |
|---|---|---|
| Runs for | **Every** lifecycle-active route, including tracking-pending ones | Tracking-active routes only |
| Needs Google Maps enabled? | **No** | **Yes** (Settings → GMaps `enabled`) |
| Threshold | Default 50 mi — the single authoritative constant lives in `lib/routeControl/routeControlConstants.js` | — |

- Completion is **atomic**: `completeRouteAssignment` uses
  `WHERE status='active' RETURNING id`, so only the winner of a race gets a row
  back and writes the audit event.
- The FINAL destination coordinate comes from the parsed/manual point. When that
  point is address-only, it falls back to the **END of the computed route
  polyline** — never a waypoint. Existing routes self-heal from their polyline on
  the next monitor pass, so an admin never has to re-create a route.

## What a monitor tick may read

The tick runs every five minutes for the life of the process, economy mode
included, so every byte it reads is paid ~288 times a day per route. Until
October 2026 it read every route whole (62 columns: polyline, link, waypoints,
message list) and echoed each write back with `RETURNING *` — measured at
~15.6 KB a tick for one tracked route, ~4.4 MB a day. It now costs ~1.7 KB, and
these rules keep it there:

- **No whole rows on the tick path** — no `SELECT *`, `r.*` or `RETURNING *`.
  The pass reads `listMonitorPassAssignments`: the columns the monitor and
  everything it calls use, after a one-column "is any route active?" probe.
  Using another route field in the pass means adding it to that list.
- **The polyline is read only when needed** — an off-route check, or the repair
  of a missing destination — then remembered by its **md5** until the route is
  recomputed (`services/routeControl/routePolyline.js`). Not by `updated_at`:
  every monitor write moves it, so the copy would never be reused.
- **Writes read nothing back.** Where another caller wants the row
  (`insertRouteMonitorEvent`, `activateTracking`), the tick has a narrow variant
  beside it (`recordRouteMonitorEvent`, `activatePendingTracking`) rather than
  a changed contract.
- **The GMaps settings are cached 10 minutes.** A 30-second cache never survived
  a 300-second tick. Every save (`updateGmapsSettings`) clears it, so a switch
  or interval change applies on the next tick; a read in flight during a save
  is never kept. Any new writer of `gmaps_settings` must clear it too.

Tests: `tests/routeMonitorQueries.test.js` (the real tick over a fake `pg` that
prices every response), `tests/routeControlMonitorPg.test.js` (the statements
against the real schema, including the completion race) and
`tests/gmapsSettings.test.js`.

## Route screenshots

One screenshot per assignment (`route_assignment_attachments`), enforced by a
unique index. Replacement is a **single UPSERT** — never delete-then-insert.

### Telegram screenshot transport is a permanent invariant

- Screenshots reach Telegram as short-lived, **HMAC-signed HTTPS URLs** produced
  by `services/routeControl/screenshotMediaReference.js` — for both
  `editMessageMedia` on existing messages and `sendPhoto` on new ones.
- **Never** revert these calls to raw `Buffer` / `{ source: file_data }` input,
  multipart upload, or anything else that pushes screenshot bytes directly from
  Render to `api.telegram.org`. That production path repeatedly stalled with no
  Telegram response even though the browser upload and the database write had
  already succeeded.
- Telegram fetches the bytes through `/api/route-screenshot-media/:id`. That
  endpoint must keep its short expiry, HMAC signature, assignment binding, and
  screenshot-content version binding. It must never expose a permanent or
  unsigned public image URL, and signed URLs and query strings must never be
  logged.
- Replacing a screenshot must invalidate the URLs for the previous image. Admin
  previews stay authenticated separately.
- Existing text-only Telegram messages must keep being converted **in place**
  with `editMessageMedia`, reusing the stored chat ID and message ID. Never
  silently post a replacement message.

### Tests to run and preserve

`tests/telegramUrlMediaTransport.test.js`,
`tests/routeScreenshotMediaReference.test.js`,
`tests/routeScreenshotMediaRoutes.test.js`, the Route Control edit/delivery
tests, and the Admin screenshot-status tests.

`telegramUrlMediaTransport.test.js` must keep proving that real Telegraf
requests go out as `application/json`, not multipart.
