# Dispatcher ETA updates, /update, /status, /load and the pinned-load reading

**Retired:** 2026-10-23, at the owner's request — "полностью убрать функцию
update и ETA" (remove the update and ETA function completely), and stop reading
the screenshot / pinned load: loads are read from the Dispatcher Board and
Datatruck instead. · **Pre-removal source:** any `main` commit before this
removal merged; the code is recoverable with
`git log --diff-filter=D -- services/dispatchEtaUpdateService.js`.

The ETA updates posted a driver's position and arrival estimate into the
driver's group (or the "Automatic updating (Test)" group in test mode) on a
per-group schedule, default every 60 minutes, configured on Settings →
Dispatcher Board. A 90-second scheduler claimed due rows from
`dispatch_eta_updates`, asked the telematics chain (Samsara, Factor ELD, Leader
ELD) where the truck was, worked out "what load is this driver on?", and routed
to that load's destination through `services/etaRoutingService.js`.

"What load" was answered by the **pinned-load reading**
(`services/dispatchPinnedContextService.js`), a chain of fallbacks: the
Datatruck active order, then the two most recent stored loads
(`group_recent_loads`), then the group's pinned message — its text, and a
pinned PDF or screenshot read by OCR and a Groq/Gemini model (AI capability
`dispatch_load_extraction`) — and finally a load-like message in the chat
history. Every pinned message the bot saw was recorded in
`group_pinned_messages` for that purpose.

`/update` ran one ETA post now, `/status` built the same snapshot on demand (in
the test group it asked for a driver's name first), and `/load` printed the
resolved load context. All three sat on the same machinery and went with it.
**`/location` stays**: it reads only the telematics chain and never needed the
load.

## What was removed

| | |
|---|---|
| `services/dispatchEtaUpdateService.js`, `services/statusSnapshotDetached.js` | the scheduler, the ETA message builder, the on-demand snapshot |
| `services/dispatchPinnedContextService.js`, `services/pinnedContext/*` | the pinned-load reading: fallbacks, trust rules, pinned file download, the model reads |
| `server/services/dispatchParserService.js` | `extractRateConRawTextFromFile`, the last piece of the Dispatch Center's parser; `server/services/` is now empty and gone |
| `services/recentLoadSelection.js`, `services/driverStatusLookupService.js` | stored-load choice; the test group's driver-name search |
| `services/loadTextPatterns.js` | folded into `services/datatruckPeerPatterns.js`, its last reader (the Datatruck peer bot's reactions); `extractLoadIdentifier`, which nothing called, went |
| `bot/dispatchStatusLookupHandlers.js`, `bot/dispatchStatusLookupSession.js` | the test group's interactive `/status` lookup |
| `/load`, `/update`, `/status` in `bot/handlers/dispatchCommandHandlers.js` | the file now registers `/location` only; `registerStatusCommand` is gone from `bot/bot.js` |
| The pinned-message capture in `bot/handlers/groupCaptureHandlers.js` | a pin is no longer recorded; `upsertGroupPinnedMessageSnapshot` / `getGroupPinnedMessageSnapshot` left `database/chatLogs.js` with the four `group_recent_loads` functions |
| `database/dispatchEta.js` | and its re-export from `database/db.js` |
| `server/routes/dispatchEtaRoutes.js` | the `/api/dispatch` mount: the four `/api/dispatch/testing-feature/*` endpoints answer 404 like any unknown API path |
| Admin: the ETA card on Settings → Dispatcher Board (`EtaTrackingCard.jsx`, `useEtaTracking.js`, and the `ToggleSwitch.jsx` / `helpers.js` only it used), `admin/src/api/dispatchEta.js` | four functions off the admin's public surface; the `apiFacade` floor is now 225 |
| `getAdminRecentLoadsForGroup` in `services/datatruckLoadService.js` | written only for the ETA card's row shape |
| Background service `dispatch_eta` | gone from `lib/operations/backgroundServiceCatalog.js` and `services/backgroundServices.js` (it was never on the economy-mode pause list) |
| AI capability `dispatch_load_extraction` | gone from `lib/ai/capabilityCatalog.js` and [`ai-decisions.md`](ai-decisions.md) |
| `getPinnedContextGeminiModels`, `INTERACTIVE_MAX_RETRY_WAIT_MS` | from `services/geminiClient.js` / `services/groqClient.js`; read only by the pinned reading |
| Config `dispatchEtaTestGroupId`, `loadIngestNotifyExtractionFailure` | `.env.example` dropped `DISPATCH_ETA_TEST_GROUP_ID`, `LOAD_INGEST_NOTIFY_EXTRACTION_FAILURE` and `GEMINI_PINNED_CONTEXT_MODELS`. A host that still sets them is unaffected; they can be deleted |
| `extractTextFromImage` in `services/documents/pdfTextExtraction.js` | the image OCR read; the rate-confirmation reader was its only caller |
| Their tests | `dispatchEtaUpdateService`, `dispatchPinnedContext`, `dispatchPinnedContextAi`, `dispatchStatusLookupHandlers`, `driverStatusLookupService`, `recentLoads`, `loadTextPatterns` (its cases moved to `datatruckPeerPatterns`), `helpers/pinnedContextHarness.js` |

## What stayed, and why

- **`/location`** (`services/liveLocationResolver.js`) — the live truck
  location for a driver group, from the telematics chain only.
- **Live Locations and its ETA.** `services/etaRoutingService.js` stays: the
  admin map's per-truck ETA and route (`services/liveLocations/eta.js`,
  `routes.js`) call it. Only the ETA *messages to drivers* went.
- **The Datatruck client and `services/datatruckLoadService.js`.** Live
  Locations, return-to-road and the load lifecycle watch read loads through
  the load service; the mileage bonus and the Gross Grand Prix use the shared
  client. Datatruck, with the Dispatcher Board, is where loads come from now.
- **`services/documents/pdfTextExtraction.js`** — the Finance Monitor's
  document reader still pulls a PDF's text layer through it (with
  `allowOcr: false`). The OCR branch remains selectable by a caller but no
  current caller asks for it.
- **`lib/telegram/fileDescriptor.js`** — the Finance Monitor's capture reads
  attachments with it.
- **The Datatruck peer bot's load-message matcher** — now inside
  `services/datatruckPeerPatterns.js`.
- **The tables** `dispatch_eta_updates`, `dispatch_eta_global_settings`,
  `group_recent_loads` and `group_pinned_messages` are read and written by
  nothing. They stay on a deployed database until an administrator drops them
  from **Settings → Retired feature leftovers** (group `dispatch_eta`) after a
  backup. The baseline no longer creates them (`008_dispatch_eta_and_loads.sql`,
  `005_chat_logging.sql`, `006_facebook_leads.sql`), so a drop stays done. No
  forward migration alters them, so no fresh-database stub was needed.
  Migration 0072 names `group_pinned_messages` but drops an index only where
  the table resolves (`to_regclass`), so it is a no-op without it.
- **The stale health rows.** Migration 0081 deletes the `dispatch_eta` row from
  `system_health_states` and `background_service_runs`; nothing writes them any
  more, and the health screen must not keep calling them `ok`.

The Dispatch Center's removal had kept the ETA schedules on purpose — see
[`retired-dispatch-center.md`](retired-dispatch-center.md). That reason (the
card was the only interface to live rows) ended with the feature itself.

## Tests that hold this in place

```
node --test tests/removedFeaturesStayRemoved.test.js  # modules, /update /status /load, worker, router, pin capture, capability
node --test tests/api-surface.test.js                # /api/dispatch/testing-feature/groups → 404 WITH a valid token
node --test tests/retiredLeftovers.test.js           # dispatch_eta is droppable and not recreated on boot
TEST_DATABASE_URL=… node --test tests/retiredLeftoversPg.test.js  # dropped on a deployed database, stays dropped
node --test tests/datatruckPeerPatterns.test.js      # the moved load-like matcher
npm test --prefix admin -- --run apiFacade DispatcherBoardTab
```
