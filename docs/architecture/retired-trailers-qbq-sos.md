# Retired: the Trailer Department, Trailer Tracking, and QBQ/SOS

**Retired:** 2026-09
**Pre-removal commit:** `97dd39e013b0c5348441b377f3ae7916993f0e92` (the tip of `main` before this work)

Three feature areas removed from the running application in one pass, because
the business no longer runs any of them. This is the record of what went, what
deliberately stayed, and how to get any of it back.

> **AI agents: do not scan, index or resurrect anything described here unless
> the user asks for that feature by name.** It is not part of this application.

---

## What they were

| Feature | What it did |
|---|---|
| **Trailer Department** (`/trailers`) | A real rental business: multi-trailer agreements with per-item pickup/return/pricing, amendment history, photo inspections, invoices with adjustments and credits, payments with overpayment banking, reports, a renter-company directory, and Telegram payment/overdue notifications. |
| **Trailer Tracking (Beta)** | AI monitoring of trailer mentions in driver-group messages — cheap keyword filter → context collection → deterministic extraction → mandatory Gemini semantic verification → registration of confirmed completed actions only, failing closed to a Needs Review ledger. Plus a trailer master list, import-from-screenshot, and a trailer map overlay on Live Locations. |
| **QBQ / SOS** | A public employee assessment at `/questions` and anonymous company-wide aggregates at `/answers` in UZ/RU/EN, scoring six thinking patterns, with a fully isolated test mode, an admin surface, and the SOS presentation hosted at `/qbq` with persistent inline edits and a paired phone remote. |

## What was removed

Roughly 35 000 lines: 49 trailer service files, 34 trailer database modules, 15
trailer route files, 82 trailer admin-SPA files, 83 trailer test files; the
`services/sosAssessment` and `services/qbq` packages, their database modules,
routers and 40 admin files, 18 test files, the committed 480 KB SOS deck and
the QBQ book text it was written from; five baseline schema segments and three
forward migrations; the `@supabase/supabase-js` dependency and every
`SUPABASE_*` / `TRAILER_*` environment variable.

Also removed, because their only consumer was one of these features:

- `config/trailerDepartmentFlag.js` and the `TRAILER_DEPARTMENT_ENABLED` kill switch
- `server/routes/adminUserScope.js` — Trailer Manager account scoping, including
  its 404-not-403 non-disclosure rule (see *Behaviour that changed* below)
- the four `trailer_*` roles and their permission-key seeds
- the trailer overlay on the Live Locations map, and the asset-view switch that
  existed only to choose between trucks and trailers

## What deliberately stayed

Three things lived inside the removal path and belonged to the rest of the
application. Each was moved out **before** anything was deleted:

1. **The whole RBAC substrate.** `admins` lifecycle columns, `permissions`,
   `roles`, `admin_user_roles`, `role_permissions`, `super_admin`, the three
   company-wide permission keys, the super-admin grant, the existing-admin
   backfill and `roles.version` were all seeded from trailer baseline segments.
   They are now `database/baseline/022_rbac_and_admin_users.sql`.
2. **The administrative audit trail.** `database/rbac.js` wrote every
   `admin.create` / `admin.update` / `role.create` / `role.update` into
   `trailer_audit_log`. It now writes to `admin_audit_log` via
   `database/adminAudit.js`, and migration `0010` copies the existing rows
   across — additively, so the trail is continuous rather than split.
3. **BOL/POD forwarding settings**, which were created at the end of the
   trailer-tracking baseline segment and are now
   `database/baseline/021_bol_pod_forwarding.sql`.

And two test files whose names were misleading:

- `tests/trailerAuth.test.js` was the only test of `server/middleware/auth.js`.
  It is now `tests/authMiddleware.test.js`, re-fixtured, and gained a case
  pinning the HS256 algorithm so an `alg:none` forgery is proven rejected.
- `tests/helpers/trailerPgHarness.js` was the repository's only PostgreSQL
  integration harness, used by ten unrelated `*Pg` suites. It is now
  `tests/helpers/pgHarness.js`.

## Behaviour that changed for surviving features

- **`admin.full_access` is the single gate for the admin panel.** The Trailer
  Department was the only feature a partially-scoped account could open, so
  there is no longer a tier of user administrator between "full" and "none". An
  account without `admin.full_access` now sees a plain "no sections available"
  message rather than a page whose every request would 403.
- **The 404-not-403 non-disclosure rule is gone with the scoping that needed
  it.** It existed so a Trailer Manager could not infer that a super admin
  existed. `server/routes/adminUserGuards.js` keeps the guard that was never
  about trailers: the last active super administrator can be neither
  deactivated nor demoted.
- **Live Locations lost its trailer overlay** and keeps everything else — the
  truck map, search, status filters, diagnostics, "Fit visible" and its
  two-minute refresh.

## Database tables — NOT dropped by the removal

Removing the code does not remove the data, deliberately: a deploy must never
destroy history. Every table stayed, with its rows.

**Settings → Retired Leftovers** is what clears them, and it is the only code
path in the application that drops a table. It shows what is left with live row
counts, and separates the two weights of action: removing the retired role and
permission rows (reversible, deactivates rather than deletes accounts) is one
button, and dropping the tables is another that requires an exact typed
confirmation phrase and tells you to take a backup first.

Drops are allow-listed and run **without `CASCADE`**, in two steps. The foreign
keys whose referencing *and* referenced table are both in the doomed set go
first — a constraint with either end outside the set is never touched, and this
is what makes a **circular** foreign key droppable at all (`trailer_media` ↔
`trailer_invoices` is one, and no ordering of plain `DROP TABLE` can break a
cycle). Then the tables go, in passes. Anything still referenced from outside
the list therefore fails and is reported rather than silently taken, which is
the entire reason `CASCADE` is not used.

Trailer (29): `trailers`, `trailer_aliases`, `trailer_audit_log`,
`trailer_company_credit_applications`, `trailer_company_credits`,
`trailer_current_status`, `trailer_events`, `trailer_import_batches`,
`trailer_import_rows`, `trailer_inspections`, `trailer_invoice_adjustments`,
`trailer_invoice_lines`, `trailer_invoices`, `trailer_master_reconciliation_log`,
`trailer_media`, `trailer_media_blobs`, `trailer_notification_jobs`,
`trailer_payment_reversals`, `trailer_payments`, `trailer_pending_instructions`,
`trailer_reminder_history`, `trailer_rental_agreements`,
`trailer_rental_amendments`, `trailer_rental_items`, `trailer_rental_movements`,
`trailer_rentals`, `trailer_renter_companies`, `trailer_settings`,
`trailer_unmatched_mentions`.

QBQ/SOS (4): `sos_settings`, `sos_submissions`, `sos_answers`,
`qbq_presentation_edits`.

⚠️ **`trailer_audit_log` is not idle.** Until migration `0010` has run it is
still where the RBAC audit history lives; after it, the rows exist in both
places and the old table is safe to drop. The migration runs automatically at
boot, so on any deployed instance this has already happened.

The three SOS/QBQ migrations were deleted from `database/migrations/`. That is
safe: the runner reports applied-but-missing versions as `orphaned` and only
logs them (`database/migrate/runner.js`), so a production boot is unaffected
and the `schema_migrations` rows can stay.

## How to restore

```bash
# Everything, as it was:
git checkout 97dd39e013b0c5348441b377f3ae7916993f0e92 -- services database server admin lib config tests docs
```

More usefully, restore one area:

```bash
git checkout 97dd39e013b0c5348441b377f3ae7916993f0e92 -- 'services/trailer*' 'database/trailer*' 'server/routes/trailer*'
git checkout 97dd39e013b0c5348441b377f3ae7916993f0e92 -- services/sosAssessment services/qbq server/qbq
```

Then re-add the integration points, none of which are subtle:

1. `server/api.js` — the trailer mount block and the SOS/QBQ mount blocks, and
   the removed paths back into the SPA catch-all (removing them from
   `server/routes/retiredRoutes.js` at the same time).
2. `bot/handlers/groupCaptureHandlers.js` — the `handleTrailerGroupMessage`
   require and its detached call inside the `group.active` block.
3. `index.js` — `startTrailerNotificationService` / `stopTrailerNotificationService`.
4. `config/config.js` — the trailer and Supabase settings, plus
   `config/trailerDepartmentFlag.js`.
5. `database/db.js` — the trailer requires and spreads.
6. `admin/src/App.jsx`, `AdminSidebar.jsx`, `api.js` — the pages, nav entries
   and API re-export.
7. `package.json` — `@supabase/supabase-js`.
8. The baseline segments, whose content is still in the pre-removal commit.

If the tables were already dropped through Settings → Retired Leftovers, the
schema comes back but the data does not. That is what the backup warning on
that screen is for.
