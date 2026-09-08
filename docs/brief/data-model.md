<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list. -->

# §8. Data model and cross-feature relationships

- **PostgreSQL, no ORM.** One `pg.Pool` in `database/pool.js` (`max=5`).
- **`database/db.js` is mostly a compatibility seam.** It re-exports **about 30**
  per-feature modules (`groups`, `driverProfiles`, `drivers`, `questions`,
  `broadcasts`, `facebookLeads`, `rbac`, …) so long-standing
  `require('../database/db')` callers keep working — if you move one of those
  exports, keep a re-export or you will break distant features. It also **still
  owns live code**: `initializeDatabase()` (the boot-time schema + migration
  entry point), the `admins` queries, the `service_runs` claim helpers and the
  group-directory queries.
- ⚠️ **The seam is NOT universal — several feature modules are required
  directly**, including `database/homeTime.js` and `database/routeControl.js`.
  `db.someHomeTimeFn(...)` is `undefined`. Check `database/db.js`'s require list
  before assuming a helper is reachable through it; new code should prefer
  requiring the feature module directly anyway.
- **Schema is applied automatically at boot**, in two layers:
  1. **Baseline** `database/schema.sql` — additive and idempotent, applied
     verbatim in one transaction on **every** boot. It is **GENERATED** from
     `database/baseline/*.sql` by `npm run build:schema`. **Do not hand-edit it**
     (CI checks it is in sync).
  2. **Forward migrations** `database/migrations/NNNN_*.sql` — run-once, tracked
     in the `schema_migrations` ledger. **All new schema changes go here**
     (`npm run migrate:new -- <name>`).
  Additive only: new columns must be nullable or defaulted, never `DROP`. A bad
  statement can crash-loop production. See `docs/database/migration-notes.md`.
- **~80 tables created by the baseline.** A database that predates the
  removals also carries the retired features' tables, which nothing reads —
  Settings → Retired Leftovers is what clears them (§4).
- **`database/baseline/*.sql` plus `database/migrations/` is the real schema** —
  read those, not a snapshot. Committed generated snapshots
  (`schema-current.md`, `relationships.md`) used to live in `docs/database/` and
  drifted to 76 tables while the baseline grew past 100; they have been removed
  and are now gitignored. `npm run db:docs` still generates a reference on demand
  against a reachable database. See `docs/database/README.md`.

### `groups` is the hub of the data model

Every driver and staff Telegram group is a `groups` row: `telegram_group_id`,
`group_type` (`driver` / `employee` / other), `language` (en/ru/uz), `active`,
plus unit and driver parsed from the Telegram title (convention
`WENZE UNIT # <unit> <NAME> (COMPANY DRIVER)`, parsed by
`lib/drivers/driverGroupTitle.js`). `driver_profiles` hangs off it one-to-one.
**Nearly every feature joins to `groups`** — surveys, broadcasts, dispatch, home
time, fuel, bonuses and Route Control.

**Cross-repo coupling:** the `samsara-integration` service also reads `groups`
(for driver-group routing) and reads the `safety_event_video_settings` /
`safety_event_music_assets` rows this repo's admin Settings tab manages, while
writing `safety_event_video_jobs`. **A `groups` schema change affects both
repos** — coordinate it.

### Other relationships worth knowing before you change something

- **Home time → road bonus → employee recognition.** A single road→home
  transition writes `driver_road_history`, may post a road-bonus summary to the
  bonus group, and posts a recognition-only (no dollar amounts) message to the
  employee group. Changing the state machine touches all three.
- **Live GPS is shared infrastructure, but there are TWO paths — a change to one
  does not fix the other.**
  - **Per-driver lookups go through `liveLocationResolver`** (Samsara → Factor →
    Leader, with transient retries): `/location`
    (`bot/handlers/dispatchCommandHandlers.js`), ETA updates and the `/status`
    snapshot (`dispatchEtaUpdateService.js`), fuel alerts, Route Control
    (`routeControl/assignmentLocation.js`), and dispatch test diagnostics.
  - **Batch/fleet fetches do NOT use it.** The Live Locations map
    (`liveLocationsService.js`) calls `samsaraLocationService` / `driveHosEldService`
    directly and re-implements the same provider order, and the duplicate-unit
    check uses Samsara only. So fixing the fallback chain in the resolver leaves
    the map unchanged — check both when you touch provider behavior.
- **Optimistic locking on roles**: `roles.version` means a custom-role edit
  that sends a stale version gets HTTP 409, never a silent overwrite.
- **Audit redaction** (`database/adminAudit.js` `redact`) recursively strips
  passwords, hashes, tokens, secrets and signed-URL material at any depth
  before an audit entry is stored. An audit row carries whole before/after
  images of an `admins` or `roles` row, so this is what keeps password hashes
  out of the audit log (`tests/adminAuditRedact.test.js`).
- **The admin audit trail survived a table rename.** `database/rbac.js` writes
  every `admin.create` / `admin.update` / `role.create` / `role.update` into
  `admin_audit_log`. Those rows used to live in `trailer_audit_log`, because the
  RBAC schema shipped inside the Trailer Department's baseline segment;
  migration `0010` copies them across, additively, so the trail is continuous
  rather than split at the rename.

---
