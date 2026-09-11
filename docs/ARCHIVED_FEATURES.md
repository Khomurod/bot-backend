# Archived features

Features that have been removed from the running application but preserved in
git so they can be recovered.

> **AI agents: do not scan, index, read, or modify an archived feature unless
> the user specifically asks you to work on that feature by name.** Archived
> code is not part of this application. Skipping it is the point — it exists so
> the repository stays small and agent context stays focused.

---

## Two modules left behind by other removals

Not features — leftovers, removed 2026-09 after a sweep for modules with no
production caller. Both are recoverable from git; neither had a reader.

**`database/sqlValues.js`** (`boundedText`). Added by
[#140](https://github.com/Khomurod/bot-backend/pull/140) for the Trailer
Tracking data layer, specifically so the same coercion was not written twice.
Trailer Tracking was retired below and took both callers with it, leaving the
helper with none.

**`services/loadExtractionValidate.js`** and its test
(`hasMinimalStructuredLoad`, `groqFieldsLookComplete`, `normalizeLine`). Added
in `48be20f` alongside `dispatchPinnedContextService.js`, and orphaned when that
service was split into `services/pinnedContext/*`: `rules.js` grew its own
`normalizeLine` — byte-for-byte identical — and `isLoadContextComplete`, and
nothing imported the old module again. The one rule that did NOT survive the
split is `hasMinimalStructuredLoad`'s looser test (a destination query of 5+
characters, *or* a pickup and delivery of 4+ each), where
`isLoadContextComplete` requires all three. Recover it from `48be20f` if that
looser rule is ever wanted; nothing has called it since the split.

This is the same class of defect `CLAUDE.md` warns about under "a green build is
not a scope check" — a module split leaving identifiers behind — caught here by
grepping every exported symbol for a caller outside `tests/`. A test file is a
caller, which is why CI was green throughout.

---

## Trailer Department, Trailer Tracking, and QBQ/SOS

**Archived:** 2026-09
**Pre-removal commit:** `97dd39e013b0c5348441b377f3ae7916993f0e92` (tip of `main`)
**Full record:** [`architecture/retired-trailers-qbq-sos.md`](architecture/retired-trailers-qbq-sos.md)

Three feature areas removed in one pass: the trailer rental business at
`/trailers`, the AI monitoring of trailer mentions in driver-group messages,
and the QBQ/SOS employee assessment with its hosted deck at `/qbq`.

Roughly 35 000 lines. The RBAC substrate, the administrative audit trail and
the BOL/POD forwarding settings were living inside the removed baseline
segments and were moved out first; the only test of the auth middleware and the
repository's only PostgreSQL harness were living inside the removed test files
and were renamed and kept.

**Tables were NOT dropped**, on the same reasoning as FleetView below: a deploy
must not destroy history. Unlike FleetView, there is now a supported way to
clear them — **Settings → Retired Leftovers**, which also lists FleetView's
nine `fleet_*` tables and the earlier retired features' tables. It is
allow-listed, non-cascading, confirmation-gated and audited. See the full
record for the table list and the restore instructions.

---

## FleetView — Fleet Operations Platform

**Archived:** 2026-07-29
**Preserved at tag:** `archive/fleetview-disabled` (commit `e6a6bb7`)

**Remote tag verified 2026-07-29** — it exists on `origin` and dereferences to the
pre-removal commit:

```bash
git ls-remote --tags origin refs/tags/archive/fleetview-disabled
# 8c5f9a69…  refs/tags/archive/fleetview-disabled       (annotated tag object)
# e6a6bb74…  refs/tags/archive/fleetview-disabled^{}    (the pre-removal commit)
```

Recovery from the remote was proven by a fresh clone at that tag: 35 `fleet/`
source files and 14 `server/fleet/` files, including `fleet/package.json` and
`server/fleet/index.js`.

A self-contained TMS-style module: a React/Vite SPA served at `/update`, a
`/api/v1/*` Express API, and a background job that rebuilt a database-cached
fleet snapshot every 120 seconds.

### Why it was archived

It was still mounted into the main app, still built on every deploy, and still
running its snapshot-sync job on an interval whether or not anyone was looking
at it. Removing it cuts production memory, deployment time, and the amount of
code AI agents have to read to understand this repository.

### What was removed

| Path | What it was |
| --- | --- |
| `fleet/` | Vite SPA (~35 source files) served at `/update` |
| `server/fleet/` | Express router (`/api/v1`, ~73 endpoints), auth, snapshot cache, sync job |
| `server/api.js` mount block | the only integration point (`mountFleet(app)`) |
| `package.json` `postinstall` | `npm ci --prefix fleet && npm run build --prefix fleet` |
| `tests/fleet.test.js`, `fleetReal.test.js`, `fleetIsolation.test.js`, `fleetDataTruckAdapter.test.js` | FleetView test suites |
| `.env.example` `FLEETVIEW_*` block | `FLEETVIEW_DATA_MODE`, `FLEETVIEW_SYNC_INTERVAL_SECONDS`, `FLEETVIEW_SNAPSHOT_STALE_SECONDS` |

`tests/assetMapFilters.test.js` was **kept** and rewritten. It used to assert
that `admin/src/utils/assetMapFilters.js` and `fleet/src/utils/assetMapFilters.js`
were byte-identical; the admin copy is now the only one, and it is still fully
covered.

### Database tables — deliberately NOT dropped

FleetView created its own tables lazily at runtime with
`CREATE TABLE IF NOT EXISTS`, inside `server/fleet/realDb.js` and
`server/fleet/snapshotRepository.js`. They were **never** part of
`database/schema.sql`, so removing that code removes the only thing that ever
created them. Nothing recreates them on boot.

These tables remain in the production database, untouched:

```
fleet_snapshots        fleet_unit_snapshots   fleet_tasks
fleet_task_comments    fleet_task_activity    fleet_audit_log
fleet_sync_log         fleet_sync_runs        fleet_settings
```

No `DROP` migration was written. Dropping them would be a destructive change,
and keeping the rows means a restore recovers the data as well as the code.
Once the code is gone nothing reads or writes them, so they cost only idle disk.

If you later want the space back: **Settings → Retired Leftovers** lists these
nine tables with their row counts and can drop them, behind a typed
confirmation. Take a backup first — per `CLAUDE.md`, destructive database
changes need explicit approval, and that screen is where an administrator gives
it.

### Deployment follow-up

The `FLEETVIEW_*` environment variables can be deleted from the Render service.
Leaving them set is harmless — nothing reads them any more.

### How to restore

```bash
git checkout archive/fleetview-disabled -- fleet server/fleet
```

Then re-add the two integration points:

1. In `server/api.js`, after the static `/admin` mount:
   ```js
   try {
     require('./fleet').mountFleet(app);
   } catch (fleetMountError) {
     console.error('[FLEET] mount failed:', fleetMountError);
   }
   ```
2. In the root `package.json` `postinstall`, append:
   ```
   && npm ci --prefix fleet && npm run build --prefix fleet
   ```

The archived tests can be recovered the same way:

```bash
git checkout archive/fleetview-disabled -- tests/fleet.test.js tests/fleetReal.test.js tests/fleetIsolation.test.js tests/fleetDataTruckAdapter.test.js
```

Restoring the SPA copy of `assetMapFilters.js` also means restoring the mirror
assertion in `tests/assetMapFilters.test.js`, or the two copies will silently
drift.
