# Database Audit Report

**Date:** 2026-07-08
**Scope:** the shared PostgreSQL database (bot-backend + samsara-integration).
**Method:** structural introspection (`information_schema` + `pg_catalog`) plus a
review of `database/schema.sql`. See the important caveat below.

> ### ⚠️ Caveat — audit basis
> The audit environment could **not reach the live production database** (the
> managed network policy only permits outbound HTTPS on port 443; the Postgres
> port is blocked, and only the DB password — no Supabase API key — was
> available). All structural findings below were produced against a **local
> PostgreSQL 16 instance loaded from the repo's `database/schema.sql`**, which
> `db.js` applies verbatim on every boot and is therefore the app's own
> declaration of the schema. **Row-level checks (orphans, duplicate driver/group
> rows, dead-tuple bloat, real index usage) require a live connection and are
> listed as "to verify on live".** Re-run `npm run db:docs` against the live DB
> to confirm the live shape matches this repo (mismatches, if any, would appear
> as tables/columns present live but absent here, or vice-versa).

Totals (from the declared schema): **73 app tables** + 3 `samsara_*` tables,
**~52 foreign keys**, **~177 indexes**. All tables have a primary key.

---

## Findings

### 1. Inconsistent timestamp types — `timestamp` vs `timestamptz`  · severity: MEDIUM · DEFER
- **Affected:** ~71 columns use `timestamp without time zone`; ~84 use
  `timestamp with time zone`. Many `*_at` columns on older tables (e.g.
  `drivers.created_at`, `chat_logs.created_at`, `broadcasts.sent_at`,
  `fuel_stop_alerts.*_at`, `groups.created_at`, `groups.status_updated_at`) are
  timezone-naive, while newer tables (`gmaps_settings`, `duplicate_unit_reports`,
  the new `safety_event_*` tables) correctly use `timestamptz`.
- **Why it matters:** mixing the two invites off-by-timezone bugs when values are
  compared or formatted, especially with a UTC server and non-UTC operators.
- **Recommended fix:** standardize on `timestamptz`.
- **Destructive?** Effectively yes — `ALTER COLUMN … TYPE timestamptz USING col AT
  TIME ZONE 'UTC'` **reinterprets** every stored value (it assumes the naive
  values are UTC). Correct only if the app has been writing UTC (it uses
  `NOW()`/`new Date()` on a UTC server — likely, but **verify per column** before
  converting). Do it table-by-table in a maintenance window; keep a backup.
- **Status:** DEFERRED. Do **not** auto-apply. Example (one column):
  ```sql
  -- Verify values are UTC first, then, in a transaction, per column:
  ALTER TABLE drivers
    ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
  ```

### 2. Redundant duplicate indexes  · severity: LOW · DEFER (safe, but a change)
Pairs of indexes covering the *same* leading columns where one is subsumed by the
other:

| Table | Keep | Redundant (droppable) |
|---|---|---|
| `driver_profiles` | `driver_profiles_group_id_unique` (unique) | `idx_driver_profiles_group_id` (also unique on `group_id`) |
| `group_pinned_messages` | `group_pinned_messages_group_id_key` (unique) | `idx_group_pinned_messages_group_id` (also unique on `group_id`) |
| `dispatch_team_drivers` | `uniq_dispatch_active_driver_profile` (unique) | `idx_dispatch_team_drivers_profile` (plain, same column) |
| `facebook_lead_sms_mirrors` | `…_telegram_chat_id_telegram_message_key` (unique) | `idx_facebook_lead_sms_mirrors_lookup` (plain, same cols) |

- **Why:** each redundant index costs write time + storage for no read benefit.
- **Fix (safe, reversible):** `DROP INDEX IF EXISTS idx_driver_profiles_group_id;`
  (etc.). Provided in `optional-index-improvements.sql`.
- **NOT redundant (do not drop):** `driver_road_history` has two indexes on
  `home_arrived_at` (`…_bonus`, `…_unposted`) — these are **partial indexes with
  different `WHERE` clauses**, so both are useful. Left as-is.

### 3. Foreign-key columns without a supporting index  · severity: LOW–MED · SAFE (opt-in file)
~16 FK columns lack their own index, e.g. `ai_insights.group_id`,
`ai_reports.group_id`, `facebook_connect_sessions.group_id`,
`facebook_page_connections.group_id`, `fuel_monitor_inbox.alert_id`,
`employee_votes.option_id`, `employee_votes_options.(group_id,poll_id)`,
`options.question_id`, `responses.(option_id,question_id)`,
`question_media.question_id`, `raise_round_submissions.team_id`,
`raise_round_picks.(submission_id,team_id)`, `raise_otp.team_id`.
- **Why:** an unindexed FK makes parent-row `DELETE`/`UPDATE` scan the child
  table, and joins on the FK slower.
- **Fix:** `CREATE INDEX IF NOT EXISTS …` — **additive and non-destructive**.
- **Status:** Provided as an **opt-in** file (`optional-index-improvements.sql`),
  NOT auto-applied, because index usage/volume could not be profiled against the
  live DB. Review each table's read/write volume, then apply. It has been
  validated to apply cleanly against the declared schema.

### 4. Telegram group/chat id stored as `text` in a few places  · severity: LOW · ACCEPT
Most Telegram ids are `bigint` (`groups.telegram_group_id`,
`*.telegram_chat_id`, `*.telegram_group_id`). Exceptions store them as `text`:
`message_group_settings.{dispatch_review_group_id, mileage_bonus_group_id,
road_bonus_group_id}` and `raise_rounds.employee_chat_id`.
- **Assessment:** in the settings table this is **intentional** — the fields are
  admin-editable, allow blanks, and fall back to env vars; `text` avoids
  cast/empty-string friction. **Accept as-is**; documented so it isn't mistaken
  for a bug. If ever normalized, validate every value parses to `bigint` first.

### 5. Identity design (positive note)
`groups` uses an internal `integer` surrogate PK (`id`, the FK target everywhere)
plus a separate `bigint telegram_group_id` (a unique key) for the real Telegram
chat id. This is a clean separation and the FK graph is consistent (all
`group_id integer` FKs point at `groups.id`). No change needed.

---

## To verify on the live database (needs a connection)
- Orphaned rows on `ON DELETE SET NULL` FKs (expected, but quantify).
- Duplicate driver/group identities (`drivers.telegram_user_id`,
  `groups.telegram_group_id` are unique — confirm no dupes slipped in before the
  constraints existed).
- Table/index bloat and **real index usage** (`pg_stat_user_indexes`) before
  dropping any index from finding #2/#3.
- Schema drift: tables/columns present live but not in `schema.sql` (or vice
  versa). Run `npm run db:docs` against live and diff `schema-current.sql`.

## Applied in this change (safe, additive)
- New tables `safety_event_music_assets`, `safety_event_video_settings`,
  `safety_event_video_jobs` (+ their indexes/constraints) — required by the
  music-overlay feature; all use `timestamptz` and CHECK-constrained enums.
- Durable DB documentation + a read-only introspection generator
  (`npm run db:docs`).
- No existing table/column/index was altered or dropped.
