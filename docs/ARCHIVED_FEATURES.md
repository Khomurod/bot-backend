# Archived features

Features that have been removed from the running application but preserved in
git so they can be recovered.

> **AI agents: do not scan, index, read, or modify an archived feature unless
> the user specifically asks you to work on that feature by name.** Archived
> code is not part of this application. Skipping it is the point — it exists so
> the repository stays small and agent context stays focused.

---

## FleetView — Fleet Operations Platform

**Archived:** 2026-07-29
**Preserved at tag:** `archive/fleetview-disabled` (commit `e6a6bb7`)

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

If you later want the space back, take a backup first and drop them by hand —
per `CLAUDE.md`, destructive database changes need explicit approval.

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
