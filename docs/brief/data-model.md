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

**The Dispatcher Board snapshot (`dispatch_board_settings` 0045,
`dispatch_board_rows` 0046) sits BESIDE both, and outranks neither.** It records
what an external spreadsheet says about today — truck, trailer, status, ETA,
dispatcher — and is keyed by `row_key` (normalised truck + normalised person)
because the board has no stable row id: a spreadsheet row number changes the
moment somebody sorts the sheet. Three rules:

- **One writer.** `services/dispatchBoard/poller.js` is the only thing that
  writes the table. Nothing else may, and nothing in it is authoritative about
  who a person permanently is.
- **A row is never deleted, and never marked absent on a failed read.**
  `present = false` plus `first_seen_at` / `last_seen_at` is the only history of
  an assignment the board itself does not keep, and "we could not read the
  board" is the opposite fact from "nobody is on the board".
- **`person_id`, `link_source` and `link_confidence` exist and are never
  written yet.** They were created with the table so the linking stage adds no
  migration; until that stage ships, a board row is matched to nobody.

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
- Three partial unique indexes hold the invariants the database never had: one
  open association per group, one open unit per person, and — since migration
  0047 — one open person per **`(fleet_type, unit_number, seat)`**. That last one
  replaced a bare `unit_number`, which could not tell Company 001 from
  Owner-Operator 001 and could not represent a team's two seats at all. Dropping
  it is the one destructive schema step in this programme, and 0047 proves there
  are zero collisions before taking it — otherwise the old index stays and a
  `serious` finding is filed. Unit `001` currently sits on four active groups; that is now
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

**The person layer is now WRITTEN and READ by the application (Phase 3-E).**

- **Kept current by `services/identity/personResolver.js`.** When the bot sees an
  active driver group without a person (capture middleware, once per group per
  ten minutes) it resolves one: the same `driver_profiles.telegram_user_id` on
  another chat → that person; the same normalized name whose other chats have
  ALL gone inactive → that person, back on a new truck (the old association is
  closed so they hold one open group); otherwise a new person. Two ACTIVE drivers
  who share a name stay two people — a namesake is not a returning driver. The
  decision is pure (`lib/identity/personResolution.js`), the write is one
  transaction, and a failure is logged — it never fails the message.
- **A saved profile keeps the truck true.** `database/driverProfiles` fires a
  `setProfileSavedHook` (registered in `index.js`, so `database/` never depends
  upward) and the resolver makes the profile's unit the person's open unit —
  closing the previous one, so 320 → 322 is a change of truck, not a second
  driver. A unit **another person still holds is not taken**: the resolver
  returns `contested` and leaves it to the watchdog, because a chat title must
  not evict anybody. A Telegram id that proves a chat belongs to a person already
  on record moves the chat to them and merges the lone person by pointer.
- **Every operational fact names its person (migration 0026).** Nullable
  `person_id` on `driver_road_history`, `driver_home_status`,
  `home_time_requests`, `fuel_stop_alerts`, `route_assignments`,
  `dispatch_team_drivers` and `mileage_bonus_progress`, stamped **at write time**
  by a subquery on the group's open association (NULL when the layer has not met
  the group — never an error), filled once for existing rows, and mileage only
  where exactly one canonical person normalizes to the name. `group_id` is
  untouched beside it.
- **Read by** the Driver Groups directory (`listGroupDirectorySourceRows` joins
  the open association: `person_id`, `person_display_name`, `person_group_count`,
  `person_unit_number`, `person_unit_history`), the Driver Groups detail modal
  (every chat and truck in time), and Raise's assignable-driver search, which now
  finds a driver by their name and **every truck they have driven**.
- **Populated from the admin**: Needs Attention → Identity previews and applies
  the Stage 1 backfill (`POST /api/operations/identity/backfill`, on the
  `operations.corrections.apply` gate) and then stamps every pre-existing row —
  so production fills without shell access. Guarded by
  `tests/personResolution.test.js`, `tests/personResolverPg.test.js` (truck
  change, old truck → new driver, returning driver, Telegram reconcile,
  stamping at every write, migration idempotency) and `tests/identityRoutes.test.js`.

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
- **The finance tables stand apart from everything else, on purpose.**
  `finance_settings` / `finance_messages` / `finance_moneycodes` have no foreign
  key to `groups`, to `driver_people` or to anything else: the finance group is
  identified by its raw Telegram `chat_id`, and a money code is tied to the
  message it came out of and to nothing further. Nothing in the driver, payroll
  or home-time chain reads them, and nothing they hold feeds a decision — a
  duplicate is recorded and never acted on. `finance_messages.text` is the
  record and is never overwritten by the parse beside it, so a tightened parser
  can re-read exactly the rows the provisional one produced
  (`docs/architecture/finance-monitor.md`).
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
