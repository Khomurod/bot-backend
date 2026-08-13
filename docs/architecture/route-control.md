# Route Control — invariants

Read this before changing anything under `services/routeControl/`,
`services/routeControlConstants.js`, or the route-screenshot endpoints.

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
| Threshold | Default 50 mi — the single authoritative constant lives in `services/routeControlConstants.js` | — |

- Completion is **atomic**: `completeRouteAssignment` uses
  `WHERE status='active' RETURNING *`, so only the winner of a race writes the
  audit event.
- The FINAL destination coordinate comes from the parsed/manual point. When that
  point is address-only, it falls back to the **END of the computed route
  polyline** — never a waypoint. Existing routes self-heal from their polyline on
  the next monitor pass, so an admin never has to re-create a route.

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
