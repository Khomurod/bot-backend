# BOL/POD document forwarding, and what is left of it

**Retired:** 2026-10, at the owner's request — "BOL и POD… полностью
отключай" (switch BOL and POD off completely). · **Pre-removal source:** any
`main` commit before this removal merged; the code is recoverable with
`git log --diff-filter=D -- services/datatruckDocumentService.js`.

BOL/POD forwarding polled the Datatruck OpenAPI every 15 minutes
(`DATATRUCK_DOC_POLL_MINUTES`) for Bill of Lading and Proof of Delivery files
attached to recent orders, and posted each one into Telegram: the matching
driver's group (matched by driver name only, never by truck number), a central
group, or both, under Settings → 📄 BOL / POD. Classification came from
Datatruck's own `file_type`; an AI fallback existed but was off by default.
Each document was forwarded at most once (UNIQUE `signature` in
`datatruck_document_deliveries`), with bounded per-destination retries.
Telegram fetched the file by URL; the bytes were relayed through this process
only as a fallback. It was one of the largest database-transfer consumers
(~100 MB a day before its October 2026 scan fix) and on the owner's
economy-mode pause list of 2026-10-09.

This file replaces `docs/architecture/bol-pod-forwarding.md`, which described
the settings model, the routing modes, the delivery ledger and the retry rules.
All of that went with the feature; what is still true about the tables it wrote
is below.

## What was removed

| | |
|---|---|
| `services/datatruckDocumentService.js`, `datatruckDocumentHelpers.js`, `datatruckDocumentSender.js` | the poller, the order → group matcher and settle/skip rules, and the URL-first sender with its download-and-upload fallback |
| `services/bolPodClassifier.js`, `services/bolPodGroupValidation.js` | the AI fallback classifier and the central-group validator |
| `database/datatruckDocuments.js`, `database/bolPodForwardingSettings.js` | the delivery ledger and the settings row queries |
| `server/routes/settings/bolPodRoutes.js` | `/api/settings/bol-pod*` (settings, validate-group, test-message, status, deliveries, retry) now answer 404 like any unknown API path |
| Admin: Settings → 📄 BOL / POD (`admin/src/pages/settings/BolPodTab.jsx`) and its client functions in `admin/src/api/settings.js` | |
| Background service `datatruck_documents` | gone from `lib/operations/backgroundServiceCatalog.js`, the roster in `services/backgroundServices.js`, and `ECONOMY_PAUSED_KEYS` in `lib/operations/economyMode.js` |
| Config keys `datatruckDocDeliveryEnabled`, `datatruckDocPollMinutes`, `datatruckDocLookbackDays`, `datatruckDocSinceIso`, `datatruckDocMaxFileMb`, `datatruckDocMediaBaseUrl`, `bolPodAiFallbackEnabled` | no longer read; `.env.example` dropped `DATATRUCK_DOC_DELIVERY_ENABLED`, `DATATRUCK_DOC_POLL_MINUTES`, `DATATRUCK_DOC_LOOKBACK_DAYS`, `DATATRUCK_DOC_SINCE`, `DATATRUCK_DOC_MAX_FILE_MB`, `DATATRUCK_DOC_MEDIA_BASE_URL` and `BOL_POD_AI_FALLBACK_ENABLED`. A host that still sets them is unaffected; they can be deleted |
| Following `bol_pod_forwarding_settings.central_group_id` on a group upgrade | removed from `lib/telegram/chatMigration.js`; `tests/telegramChatMigration.test.js` lists the column in `NOT_DESTINATIONS` |
| Its tests | `bolPodDirectFetch`, `bolPodIntakeRetired`, `bolPodRouting`, `bolPodSettings`, `bolPodSettingsRoute`, `datatruckDeliveryStatesPg`, `datatruckDocumentHelpers`, `datatruckDocumentService` |

The `identity.silent_active_group` finding no longer warns that deactivating
stops document routing; its side-effect text now says the group drops out of
broadcasts, Live Locations and home-time tracking.

## What stayed, and why

- **The Datatruck client.** `services/datatruckApiService.js` is shared by Live
  Locations, the mileage bonus, the Gross Grand Prix, return-to-road detection
  and, through `services/datatruckLoadService.js`, load control and `/load`. `fetchOrdersByDocumentWindow`, written for this feature, is
  still used by Live Locations (`services/liveLocations/orders.js`). The client
  never uploads anything.
- **The tables** `datatruck_document_deliveries` (the only record of what was
  forwarded where) and `bol_pod_forwarding_settings`, plus the older
  `bol_pod_monitor_settings`, are read or written by nothing. They stay on a
  deployed database until an administrator drops them from **Settings →
  Retired feature leftovers** (group `bol_pod`) after a backup. The baseline no
  longer creates them (`013_bot_access_and_datatruck_docs.sql`,
  `021_bol_pod_forwarding.sql`), so a drop stays done.
- **The stale health row.** The `datatruck_documents` row in
  `system_health_states` is deleted by migration 0073; nothing writes it any
  more, and the health screen must not keep calling it `ok`.
- **The older intake/upload pipeline stays removed.** Before forwarding came
  under admin control, drivers could post documents in their group to be
  AI-classified, matched to a load and uploaded to Datatruck. That never ran
  live — Datatruck's OpenAPI documents no upload endpoint — and was removed in
  PR #97. Its guard lived in `tests/bolPodIntakeRetired.test.js`, which went
  with forwarding, so it is now in `tests/removedFeaturesStayRemoved.test.js`.
  Its four tables (`telegram_document_batches`, `telegram_document_files`,
  `datatruck_upload_attempts`, `bol_pod_monitor_settings`) are no longer
  created; a database that already has them keeps them.
- **The URL rule.** Media goes to Telegram by URL, not as bytes from this
  process ([§9 of the brief](../brief/invariants.md)). Forwarding was the last
  code to hand Telegram a third-party file URL, and its guard
  (`tests/bolPodDirectFetch.test.js`) went with it; the rule stands for
  whatever sends media that way next.

`tests/removedFeaturesStayRemoved.test.js` fails if any of it comes back.
