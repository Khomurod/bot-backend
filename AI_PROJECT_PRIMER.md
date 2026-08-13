# AI PROJECT PRIMER — superseded by `APP_BRIEF.md`

> **This document has been replaced. Read [`APP_BRIEF.md`](APP_BRIEF.md) instead.**

The former primer described a state of the application that no longer exists.
It was verified against the code and found to be materially stale — keeping it
alongside a second, accurate brief would have left two root-level documents
disagreeing about how the app works. Its content was re-derived from the current
source and now lives, corrected, in `APP_BRIEF.md`.

The most misleading claims it carried, for anyone who read it before this change:

| The old primer said | The application actually |
|---|---|
| "**No role system** in the admin panel — any admin token grants all admin APIs" | has full RBAC: `roles` / `permissions` / `role_permissions` / `admin_user_roles`, five built-in role keys, custom `custom_*` roles, `requirePermission` gates, and Trailer-Manager account scoping that returns 404 rather than 403 |
| `server/api.js` is "~3,100 lines" with feature routes inline | is a ~330-line assembly file; every feature route lives in `server/routes/` |
| `database/db.js` is "~3,600 lines — every query is a named function" | is a ~330-line re-export seam over per-feature modules in `database/` |
| "64 tables" | has ~114 |
| "~84 service modules" | has far more, including package directories for Route Control, the Trailer Department, trailer master list/storage/agreements/pricing, the trailer monitor, SOS and QBQ |
| "~19 tests fail in a bare environment" — treat as an expected baseline | passes clean with no secrets and no database: 0 failures. A failure is a real failure |
| no mention of them at all | runs the **Trailer Department** rental business, **Trailer Tracking**, **Route Control**, **auto-reactions**, the **QBQ/SOS assessment** and the **hosted QBQ presentation** |

Deeper reference material remains valid where it is: `CLAUDE.md` (working rules
and per-feature invariants), `docs/database/` (generated schema reference),
`docs/ARCHIVED_FEATURES.md` and `docs/architecture/retired-*.md` (what was
removed and why), `docs/trailer-department.md`, `README.md` (setup and endpoint
reference).
