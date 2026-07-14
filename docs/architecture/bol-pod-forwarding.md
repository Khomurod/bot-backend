# BOL / POD document forwarding (admin-controlled)

Forwards Bill of Lading (BOL) and Proof of Delivery (POD) documents from the
DataTruck OpenAPI to Telegram groups, under full admin control from
**Settings → BOL / POD**.

## Why this exists / history

- A previous **BOL/POD intake + upload** feature (drivers post documents in
  their Telegram group → AI classify → match a load → confirm → *upload the file
  to DataTruck*) was fully **removed** in PR #97 (commits `c5c5bea`, `3c9ec32`).
  It never ran live: DataTruck's public OpenAPI documents *reading* an order's
  `documents[]` but **not** an upload endpoint, so the guessed upload path stayed
  permanently behind a dry-run gate. Combined with several fragility fixes
  (silent `ON CONFLICT` partial-index failure, a mismatch-upload risk, button
  auth churn), it was cut during an AI-consolidation cleanup. **It is not
  restored** — this feature does not upload anything to DataTruck.
- A separate, reliable **DataTruck → Telegram delivery** service survived
  (`services/datatruckDocumentService.js` + `database/datatruckDocuments.js` +
  table `datatruck_document_deliveries`). It already polls DataTruck, extracts
  BOL/POD documents by their authoritative `file_type`, matches each order to a
  driver's Telegram group **by driver name only**, and forwards the file with a
  caption — idempotently (UNIQUE `signature`) and with bounded retries.

This feature **brings that surviving delivery service under admin control** and
adds central-group routing, per-destination tracking, validation, and an admin
UI. Everything is **OFF by default**.

## Where documents come from / how the driver + load + group are identified

- **Source:** DataTruck OpenAPI order `documents[]` only (no Telegram intake).
  `file_type` is authoritative — `bill_of_lading` → BOL, `proof_of_delivery` →
  POD. Classification is therefore **deterministic from metadata**; the AI
  classifier is only a defensive fallback for genuinely-ambiguous documents and
  is **off by default** (`BOL_POD_AI_FALLBACK_ENABLED`).
- **Driver / load:** taken from the DataTruck order (driver names, `load_id` /
  `shipment_id`, order `id`). The order `id` + `file_type` + upload timestamp
  form the stable dedup `signature`.
- **Driver group (never guessed):** `listCanonicalDriverGroups()`
  (`services/driverGroupDirectoryService.js`) → `buildGroupMatchIndex()` →
  `matchDocumentToGroup()` (`services/datatruckDocumentHelpers.js`), matching by
  normalized driver name against canonical, active, operationally-visible
  `groups` rows where `group_type='driver'`. No match → the driver destination
  is marked *needs review* (`skipped_no_group`); nothing is sent to an unrelated
  group.
- **Central group:** a single admin-configured Telegram chat id, validated
  server-side (see below). Distinct from any driver group.

## Settings model

New singleton table **`bol_pod_forwarding_settings`** (`id = 1`). It is a fresh
table, not a reuse of the retained legacy `bol_pod_monitor_settings` (whose
columns describe the removed test-monitor) — so historical data is left
untouched and the new routing semantics stay clean.

| Field | Meaning | Default |
|---|---|---|
| `enabled` | master on/off | `FALSE` |
| `delivery_mode` | `driver_group` \| `central_group` \| `both` | `driver_group` |
| `central_group_id` | central Telegram chat id | `NULL` |
| `central_group_title` | validated title (display only) | `NULL` |
| `central_group_validated_at` | last successful validation | `NULL` |
| `document_type_mode` | `bol` \| `pod` \| `both` | `both` |
| `uncertain_document_policy` | `do_not_send` \| `central_review` | `do_not_send` |
| `last_tested_at` | last successful test message | `NULL` |
| `updated_by` / `updated_at` | audit | — |

No secrets are stored here. The Telegram bot token stays server-side only.

**Enable guard:** `enabled` cannot be set true in `central_group`/`both` mode
until the central group has been validated.

## Delivery tracking (per-destination)

The existing `datatruck_document_deliveries` table is **extended additively**
with a parallel set of central-destination columns; the existing columns serve
the *driver* destination. One row per document `signature` tracks both
destinations independently.

- Driver destination: `status`, `group_id`, `telegram_group_id`,
  `telegram_message_id`, `attempt_count`, `last_error`.
- Central destination (new): `central_status`, `central_telegram_group_id`,
  `central_telegram_message_id`, `central_attempt_count`, `central_last_error`.
- Also new: `doc_classification`, `classification_source`.

Per-destination statuses: `pending`, `processing`, `sent`, `failed`,
`skipped_no_group` (driver only), `skipped_not_applicable` (destination not in
mode), `skipped_same_group` (central == driver group), `skipped_unclear`,
`skipped_duplicate`, plus the pre-existing `suppressed_backfill` /
`suppressed_bot_upload`. The admin history computes a roll-up
(`sent` / `partially_sent` / `failed` / …).

## Routing behavior

- **Disabled:** the poll does nothing; no Telegram messages; history preserved.
- **driver_group:** send to the matched driver group only; central marked
  `skipped_not_applicable`.
- **central_group:** send to the configured central group only; driver marked
  `skipped_not_applicable`. Driver-group lookup never blocks central delivery.
- **both:** send to driver group **and** central group, tracked separately.
- **Same-group protection:** if the central id equals the resolved driver group
  id, send once (driver) and mark central `skipped_same_group`.
- **Partial failure:** the succeeded destination is terminal; only the failed
  destination is retried (bounded).

## Duplicate & loop prevention

- Stable per-document `signature` (`dt-doc|<orderId>|<fileType>|<uploadedAt>|<seq>`)
  with a UNIQUE constraint; terminal statuses are never re-sent.
- Each destination retried independently under an attempt cap + stale window.
- The DataTruck source is outbound-only (documents are never re-ingested from
  Telegram), so there is no forwarding loop. Bot-sent messages are also recorded
  by `botSentMessageRegistry` for the app's general loop safety.

## Retry & failure handling

- Per-destination claim via a conditional `UPDATE … SET status='processing'
  WHERE status IN (eligible) AND attempt_count < cap AND updated_at < now-stale`
  — atomic, so two processes cannot double-send the same destination.
- Attempt cap (`maxAttempts`, default 6); after the cap the destination is
  `failed` and shown in the admin history. A transient Telegram/DataTruck error
  never crashes the service; one bad document does not stop the batch.

## Migration safety

- All schema changes are **additive and idempotent**, appended to
  `database/schema.sql` (which runs verbatim on every boot via
  `initializeDatabase()`): `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT
  EXISTS`, additive CHECK migration via `DO $$ … $$` (drop + re-add — already the
  established pattern for `datatruck_document_deliveries`), and `INSERT … ON
  CONFLICT (id) DO NOTHING` seed. No table is dropped, renamed, or truncated; the
  retained legacy BOL/POD tables are untouched. Safe to run repeatedly.

## Behavior change on deploy

The surviving delivery service was previously **on by default** (env
`DATATRUCK_DOC_DELIVERY_ENABLED`). Under this feature the **DB master toggle is
the source of truth and defaults OFF**, so after deploy no BOL/POD documents are
forwarded — to any group — until an administrator enables the feature in
Settings → BOL / POD. `DATATRUCK_DOC_DELIVERY_ENABLED=false` remains an
additional env kill-switch. Effective = env kill-switch **and** DB `enabled`
**and** DataTruck configured.

## Security

- All settings endpoints require the existing admin Bearer-JWT (`authMiddleware`).
- Group ids validated server-side; settings values validated against
  allow-lists; all SQL parameterized.
- No secret (bot token, DataTruck token, DB URL) is ever returned to the
  frontend or logged.
