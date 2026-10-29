# Archived features

Features that have been removed from the running application but preserved in
git so they can be recovered.

> **AI agents: do not scan, index, read, or modify an archived feature unless
> the user specifically asks you to work on that feature by name.** Archived
> code is not part of this application. Skipping it is the point — it exists so
> the repository stays small and agent context stays focused.

---

## The Finance Monitor (money codes)

Removed 2026-10-23 at the owner's request. Gone: money-code capture from the
finance Telegram group, the label-based money-code parser with its void and
replacement reading, the AI capabilities `finance_message_reading` and
`finance_document_extraction`, the attachment reader (`finance_document_reader`),
the re-read pass after a parser change (`finance_reparse`), the weekly
money-code summary (`finance_weekly_report`), the Finance page under Operations
with `/api/finance/*`, and Settings → Finance with `/api/settings/finance*` (all
now 404). The PDF text extraction, the attachment descriptor and `tesseract.js`
went with their last caller. The Telegram file download Safety Approvals uses
stayed, moved to `services/telegram/fileDownload.js`. The six `finance_*` tables
— the only money-code record — are kept for the backed-up cleanup. Details in
[`architecture/retired-finance-monitor.md`](architecture/retired-finance-monitor.md).

---

## Dispatcher ETA updates, /update, /status, /load and the pinned-load reading

Removed 2026-10-23 at the owner's request ("полностью убрать функцию update и
ETA" — remove the update and ETA function completely), together with reading
the screenshot / pinned load: loads are read from the Dispatcher Board and
Datatruck instead. Gone: the ETA scheduler (`dispatch_eta`), the ETA card on
Settings → Dispatcher Board and its `/api/dispatch/testing-feature/*` API (now
404), the `/update`, `/status` and `/load` commands with the test group's
`/status` lookup, the pinned-load reading and its AI capability
`dispatch_load_extraction`, the stored recent loads, and the recording of
pinned messages. `/location` and Live Locations' own ETA stay. What was
removed, what was kept (`etaRoutingService`, the Datatruck load service, the
four tables) and why are in
[`architecture/retired-dispatch-eta.md`](architecture/retired-dispatch-eta.md).

---

## Fuel: stop reminders, the risk watch, readings and the Fuel Monitor

Removed 2026-10 at the owner's request ("полностью все, что связано с топливом,
убираем" — everything to do with fuel goes): the gas-station address
recognition in driver groups and its proximity reminders, the fuel risk watch,
the truck fuel readings store, the admin Fuel Monitor page
(`/api/fuel-monitor` now 404), the `fuel_stop_alerts` and `fuel_risk`
background services, the `fuel` notification category, the two fuel AI
capabilities, the fuel consistency check, the driver context's fuel section,
and the `eld_location_freshness` health line that was computed from fuel
readings. What was removed, what was kept (the Samsara request, the three
tables) and why are in
[`architecture/retired-fuel.md`](architecture/retired-fuel.md).

---

## BOL/POD document forwarding

Removed 2026-10 at the owner's request ("BOL и POD… полностью отключай" —
switch it off completely): the Datatruck poller that forwarded Bills of Lading
and Proofs of Delivery to driver groups and a central group, its settings tab
(Settings → BOL / POD, `/api/settings/bol-pod*` now 404), the
`datatruck_documents` background service and its config keys. The shared
Datatruck client stays. What was removed, what was kept (the two tables, the
guard against the older intake/upload pipeline) and why are in
[`architecture/retired-bol-pod.md`](architecture/retired-bol-pod.md).

---

## Route Control

Removed 2026-10 at the owner's request: Google Maps route links pasted into
driver groups, the route monitor (off-route warnings, auto-completion), route
screenshots, the admin Route Control page and Settings → GMaps. The pre-removal
commit, what was removed, what was kept (ETA's Google key, the tables) and why
are in [`architecture/retired-route-control.md`](architecture/retired-route-control.md).

---

## The driver-raise review, and the Dispatcher Board's identity checks

Removed 2026-10 at the owner's request ("we no longer raise rates; dispatchers
are no longer asked"): the weekly 75¢/mile review round, the public `/raise`
page (now 410) and its one-time codes, the Driver Raises admin page, the Sunday
dispatch-team roster rebuild from the Dispatcher Board, the *Dispatch Rate
Review* and *Driver Raise Results* Telegram routing, and the dispatch-team join
on the Users tab. What was removed, what was kept (the tables, two routing
columns, the retired check keys) and why are in
[`architecture/retired-driver-raise.md`](architecture/retired-driver-raise.md).

The **Dispatcher Board stays**, read for Home Time's home-in / home-out (and,
since 29 October 2026, as the source of truth for the Board ↔ Bitrix check —
a different thing: it compares Bitrix and asks a person, and links nobody).
Its identity checks, the `board.link_person` correction (the only action ever
armed for automatic rollback), the board-vs-Home-Time contradictions and the
board panels on Groups, the person identity panel and Operations → Identity went
with the review — see
[`architecture/dispatcher-board.md`](architecture/dispatcher-board.md).

---

## The "is home!" post to the employee group

Removed 2026-10-06 at the owner's request. When a company driver came home after
more than the road allowance (4 weeks), `services/homeTimeService.js`
`postHomecomingRecognition` posted to the EMPLOYEE group:

> 🏠🎉 **DRIVER NAME (Unit 325) is home!** Off the road after **16 weeks**
> (117 days) of keeping us rolling. Thank you for the dedication out there —
> welcome back! 👏

Once Home In was detected automatically (driver messages and the Dispatcher
Board), it fired far more often, and a stale road clock could put a misleading
number of weeks into a company-wide chat.

**Only that message was removed.** Unchanged: the trip row and its bonus in
`driver_road_history`, the road-bonus summary to the Extra Week / Road Bonus
group (`roadBonusNotifierService`), the managers' "Driver Is Home" notice, and
everything else sent to the employee group (birthdays). Guarded by
`tests/removedFeaturesStayRemoved.test.js` and `tests/homeTimeService.test.js`.
Recoverable from git (the commit removing `postHomecomingRecognition`).

---

## Two modules left behind by other removals

Not features — leftovers, removed 2026-09 after a sweep for modules with no
production caller. Both are recoverable from git; neither had a reader.

**`database/sqlValues.js`** (`boundedText`). Added by
[#140](https://github.com/Khomurod/bot-backend/pull/140) for the Trailer
Tracking data layer, specifically so the same coercion was not written twice.
Trailer Tracking was retired below and took both callers with it, leaving the
helper with none.

**`services/loadExtractionValidate.js`** and its test (the pinned-context
reader it mentions was itself removed on 2026-10-23)
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

## Dispatch Center — Send Load

**Archived:** 2026-09
**Pre-removal commit:** `051870e2338d2986011f826eb8c88fc03ebfd3fe` (tip of `main`)
**Full record:** [`architecture/retired-dispatch-center.md`](architecture/retired-dispatch-center.md)

The `/dispatch` page: upload a rate confirmation, have a model turn it into a
dispatch card, pick a driver's chat, send it. Removed with its parser, its AI
capability, its three API calls and its per-group diagnostics expander.

**The ETA schedules that shared the page were NOT removed then.** That tab was
the only UI for per-group ETA delivery and the global intervals, so deleting it
would have turned a screen removal into a data change — settings editable only
by hand in the database. It moved to **Settings → Dispatcher Board** as
`EtaTrackingCard`, with its four `/api/dispatch/testing-feature/*` endpoints
unchanged. The ETA feature itself was removed on 2026-10-23 (entry above).

Nothing was dropped from the database and no table belonged to this feature.
`/dispatch/*` answers **410** rather than falling through to the SPA, because the
shell finding no dispatch section would silently render Driver Groups instead —
a held bookmark quietly opening an unrelated page is worse than an error. The
bare `/dispatch` has since (October 2026) become the Gross Grand Prix
dispatchers' race, a new page ([`architecture/gross-race.md`](architecture/gross-race.md)).

---

## Trailer Department, Trailer Tracking, and QBQ/SOS

**Archived:** 2026-09
**Pre-removal commit:** `97dd39e013b0c5348441b377f3ae7916993f0e92` (tip of `main`)
**Full record:** [`architecture/retired-trailers-qbq-sos.md`](architecture/retired-trailers-qbq-sos.md)

Three feature areas removed in one pass: the trailer rental business at
`/trailers`, the AI monitoring of trailer mentions in driver-group messages,
and the QBQ/SOS employee assessment with its hosted deck at `/qbq`.

Roughly 35 000 lines. The RBAC substrate, the administrative audit trail and
the BOL/POD forwarding settings (that feature itself retired in October 2026)
were living inside the removed baseline segments and were moved out first; the only test of the auth middleware and the
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
