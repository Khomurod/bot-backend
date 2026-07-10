# Trailer Tracking — Follow-up Audit (Part 0)

Baseline: `main` @ PR #99 merge. All 936 backend tests green with dummy env.
Real PostgreSQL 16 confirms `schema.sql` applies cleanly twice (idempotent).

## 1. Current trailer flow
Driver-group message → `bot/handlers/groupCaptureHandlers.js` (detached, never
throws) → `services/trailerMonitorService.handleTrailerGroupMessage`:
cheap keyword filter → `parseTrailerMessage` (deterministic) → optional AI
fallback (`trailerClassifier`) → for a clear **pickup/dropoff**: ensure trailer,
optional geocode of `location_text`, insert one immutable event, apply to
`trailer_current_status`, reply + 👍 react; for **mention_only/unidentified**:
store event + report to the Automatic-Updating test group. Dedupe is by
`(telegram_group_id, telegram_message_id)`.

**Single-event only.** The parser returns ONE event, so a message naming two
trailers registers at most one. The DB unique index also blocks a second row for
the same message.

## 2. DB tables & unique indexes
`trailers`, `trailer_events`, `trailer_current_status`, `trailer_import_batches`,
`trailer_import_rows`, `trailer_settings`. Unique index
`uniq_trailer_events_tg_message` on `(telegram_group_id, telegram_message_id)`
(partial). `current_status` derived from latest pickup/dropoff via
`applyEventToCurrentStatus` (out-of-order safe by `last_event_at`). No review
audit columns; no `event_index`; no `location_source`.

## 3. Bot handler registration
Wired once in `groupCaptureHandlers.js:267`, detached + `.catch`. Monitor already
`try/catch`-wraps everything and returns instead of throwing. Fail-soft. ✅

## 4. Admin Trailer Tracking UX
`admin/src/pages/TrailerTrackingPage.jsx`: tabs List / Import / Events /
Unidentified / **Map** / Settings. Drawer is **read-only** (no edit, no
accept/decline). Status badge shows "… • review" from `trailer.needs_review` but
is not actionable.

## 5. Live Locations map
`admin/src/pages/LiveLocationsPage.jsx`: truck triangles, route line for selected
unit, provider filters, diagnostics, 45s auto-refresh. Fixed `height:620`. No
trailers. Robust fail-soft map init already present.

## 6. FleetView trailer behavior
`fleet/src/pages/TrailerTrackingPage.jsx` (own tab + own small 380px map).
Operational map `DispatchMap.jsx` has no trailers. Read-only fleet endpoints
`/trailers/current|map|:id/timeline` already degrade to empty on error. ✅

## 7. Crash / memory risks (503 on Render)
- **`--max-old-space-size=256`** (package.json start). Screenshot import allows
  **12 files × 10 MB = 120 MB** held in memory, then base64 (~+33%) → OOM on the
  256 MB heap / 512 MB instance. **Top import-time crash vector.**
- Whole `schema.sql` runs as ONE `pool.query`; any failing statement throws →
  `initializeDatabase` throws → `process.exit(1)`. A non-idempotent trailer
  migration would hard-fail boot. Migration MUST be `IF [NOT] EXISTS`-guarded.
- Trailer route mounting (`server/api.js:166`) is NOT wrapped in try/catch (unlike
  the fleet mount). A throw while building the router would take down the whole
  API. → wrap it.
- Gemini image processing (`geminiClient`) is required at module load by
  `trailerImportService`/`trailerClassifier` (small), but base64 of large images
  is the real cost — keep buffers bounded.
- No geocoding loop on boot today (good) — must keep it that way; backfill must be
  admin-triggered + capped.
- Monitor + fleet trailer endpoints already fail-soft.

## Plan of record
Additive schema only (`ADD COLUMN IF NOT EXISTS`, new indexes, drop old index with
`IF EXISTS`). Multi-event via `event_index` + widened unique index. Review audit
columns + recompute-from-non-declined. Live Locations trailer overlay (rectangles,
derived-from-driver). Remove admin Map tab. Import batch cap (~35 MB) + single
default. Wrap trailer route mount. Real-PG idempotency test gated on
`TEST_DATABASE_URL`.
