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

**But a `groups` row is three real-world things at once** — a PERSON
(`driver_birthday`), a TRUCK (`samsara_vehicle_id`, the unit parsed out of the
title) and a TELEGRAM CHAT (`telegram_group_id`) — and all 20 of those foreign
keys bind a driver's history to the *chat*. Recreate the chat and the human
starts from zero: in production, 20 people hold two `driver_profiles` each, two
of those pairs are both active, and one driver's road clock reset mid-cycle when
their group was recreated, costing about four weeks of accrual and the bonus
with it.

`samsara_vehicle_id` was NULL on all 209 rows for the whole life of the column —
indexed, with a reader and a writer, and nothing calling the writer — so every
cross-system join resolved a driver by parsing a string out of a chat title.
`duplicateUnitCheckService` now writes it, and `samsara-integration` prefers it
over the parse when routing a safety alert. The parse stays underneath as the
fallback, and files a finding whenever it is the one that answered.

**The person layer (`driver_people`, `driver_person_groups`, `driver_units`,
migration 0015) sits ABOVE `groups` and fixes that additively.** No foreign key
was repointed and no history moved — a person is resolved *through* the existing
join. Three rules are worth knowing before touching it:

- `driver_people.normalized_key` is **indexed, not unique**. Two humans really do
  normalize alike; a UNIQUE constraint on a normalized name is the bug that
  already exists in `mileage_bonus_progress.driver_normalized_name TEXT UNIQUE`,
  where colliding drivers merge and one silently stops being paid.
- A merge is `merged_into_person_id` — a **pointer, not a deletion**. Both people
  and all their history stay; undoing it is one column back to NULL.
- Two partial unique indexes hold the invariants the database never had:
  one open association per group, and one open unit per person **and** one open
  person per unit. Unit `001` currently sits on four active groups; that is now
  unrepresentable, so the backfill leaves contested units unclaimed and reports
  them rather than picking a winner.

Unit numbers are stored **exactly as written** — `001`, `01` and `1` are three
different trucks in this fleet, and normalizing the zeros away would fabricate
collisions.

`npm run backfill-driver-people` populates it. **It is a dry run unless you pass
`--apply`**, it is safe to re-run (a group that already belongs to somebody is
skipped), and it only links two groups automatically when they share a
`driver_profiles.telegram_user_id` — a hard anchor. A shared *name* is reported
as a candidate and never merged. Guarded by `tests/personBackfillPlan.test.js`,
`tests/personIdentityLayerPg.test.js` and `tests/personBackfillPg.test.js`.

**Nothing in the application reads the person layer yet.** It is deliberately
inert until a later stage wires it in, which is what makes adding it incapable
of changing existing behaviour.

**Cross-repo coupling:** the `samsara-integration` service also reads `groups`
(for driver-group routing) and reads the `safety_event_video_settings` /
`safety_event_music_assets` / `samsara_settings` rows this repo's admin Settings
tab manages, while writing `safety_event_video_jobs` and
`samsara_video_recovery_jobs`. **A `groups` schema change affects both repos** —
and so does a change to any of those five tables. Coordinate it.

`samsara_settings` (one row, id = 1) is the configuration channel between the
two services: the Samsara API key, the safety-event switches and everything
about missing-video recovery. `samsara_video_recovery_jobs` is the durable queue
that replaced an in-memory timer — one row per safety event alerted without
video, holding the Telegram messages to fold the clip into, the Samsara
retrieval it is waiting on, the attempt count and a terminal state that says
what happened. Neither table ever stores a signed media URL, and the API key is
encrypted with the shared envelope (`lib/security/sharedIntegrationCrypto.js`),
not `facebookCrypto` — the poller holds none of this app's secrets.

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
