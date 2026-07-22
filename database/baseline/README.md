# Baseline schema segments

These files are the **source of truth** for the baseline schema. They are
concatenated — in zero-padded filename order — into the generated
`database/schema.sql` by `scripts/build-schema.js`.

```
edit database/baseline/NNN_domain.sql
        │
        ▼  npm run build:schema
database/schema.sql   (GENERATED — do not hand-edit)
        │
        ▼  applied verbatim, in one transaction, on every boot
   PostgreSQL
```

`database/schema.sql` is what the app applies (`database/db.js →
initializeDatabase()`), what the PG test harness applies, and what the docs
generator reads. It is a committed build artifact; a test
(`tests/schemaBaselineBuild.test.js`) fails if it drifts from these segments, so
always run `npm run build:schema` after editing a segment.

## What the baseline is

The baseline is the **accumulated, additive, idempotent** schema: every
statement is `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT
EXISTS`, `CREATE INDEX IF NOT EXISTS`, a name/definition-guarded `DO $$` block,
or an `INSERT ... ON CONFLICT`/marker-guarded backfill. It re-runs safely on
every boot and self-heals seed rows. That property is a hard invariant — see
`CLAUDE.md` and `docs/database/migration-notes.md`.

## Ordering is significant — do not reorder across segments

The segments are a **pure, order-preserving partition** of the historical
schema. Statements appear in dependency order: a table's columns and seeds
precede the constraints/backfills that depend on them (e.g. Phase-4 rental
backfills run before the constraints that assume the backfilled rows exist).
For that reason schema DDL, seed `INSERT`s, and one-time backfills are kept
**together, in original order, inside each domain segment** rather than split
into separate global "schema / seed / backfill" phases — moving a backfill after
a dependent constraint would break a fresh boot.

Within a segment, keep the same discipline: add a new column next to its table,
and place any backfill for it after the column is added.

## Where NEW changes go

New schema/seed/backfill changes do **not** get appended here. They are
versioned, run-once forward migrations under `database/migrations/`, tagged with
`-- migrate:kind: schema|seed|backfill`, and tracked in the `schema_migrations`
ledger. See `database/migrations/README.md`. The baseline is only re-segmented
or "squashed" deliberately, as a maintenance task, once a batch of forward
migrations has shipped everywhere.

## Segments

| # | File | Domain |
|---|------|--------|
| 001 | `core_identity` | groups, driver_profiles, drivers, group_members |
| 002 | `feedback_questions` | questions/options/translations, responses |
| 003 | `admins_and_bot_visibility` | admins, bot-visibility diagnostics |
| 004 | `employee_engagement` | employee votes/polls, broadcasts, scheduled_messages |
| 005 | `chat_logging` | chat_logs, bot_sent_messages, group_pinned_messages |
| 006 | `facebook_leads` | facebook_* connect/pages/webhooks/auto-message, ai_reports |
| 007 | `birthdays_and_service_runs` | employee_birthdays(+settings), service_runs |
| 008 | `dispatch_eta_and_loads` | dispatch_eta_*, group_recent_loads, annotations, ai_insights |
| 009 | `mileage_bonus_and_leads` | mileage_bonus_*, leads |
| 010 | `dispatch_teams` | dispatch_teams(+drivers/members) |
| 011 | `raise_approval` | raise_settings/rounds/submissions/picks/otp |
| 012 | `home_time` | home_time_settings, driver_home_status, driver_road_history, home_time_requests |
| 013 | `bot_access_and_datatruck_docs` | bot_access_settings, datatruck_document_deliveries |
| 014 | `fuel_monitoring` | fuel_stop_alerts, fuel_monitor_inbox |
| 015 | `driver_location` | driver_location_monitors, driver_location_checkins |
| 016 | `bot_users_and_reactions` | bot_users, auto_reaction_rules |
| 017 | `eld_and_message_groups` | eld_settings, message_group_settings |
| 018 | `ringcentral` | ringcentral_settings, recruiters, ringcentral_calls |
| 019 | `gmaps_and_route_control` | gmaps_settings, route_assignments(+attachments), route_monitor_events, duplicate_unit_reports |
| 020 | `safety_events` | safety_event_music_assets, safety_event_video_settings/jobs |
| 021 | `trailer_tracking` | trailers, trailer_events, trailer_current_status, imports, trailer_settings, pending_instructions, bol_pod_forwarding_settings |
| 022 | `trailer_department_rbac_rentals` | permissions/roles/RBAC, rentals, inspections, movements, media, invoices, payments, audit_log |
| 023 | `trailer_master_list` | trailer_aliases, trailer_unmatched_mentions, master_reconciliation_log |
| 024 | `trailer_media_storage` | trailer_media_blobs |
| 025 | `trailer_agreements` | rental_agreements/items/amendments, invoice_lines, company_credits(+applications), Phase-4 backfills |

> The trailer-department section marker (`-- TRAILER DEPARTMENT: RENTAL + ASSET
> MANAGEMENT`, in segment 022) is load-bearing: the PG test harness slices the
> assembled schema on it. Keep it intact.
