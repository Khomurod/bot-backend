# Trailer Department operations

## URLs

`/trailers` is the department's public-facing slug and the canonical location of
every page:

| URL | Opens |
| --- | --- |
| `/trailers` | The department at the first section the account may open (Home for most) |
| `/trailers/{section}` | `home`, `rentals`, `trailers`, `money`, `more` |
| `/trailers/{section}?tab=…&…` | A sub-tab, a selected record, and list filters |

Direct entry, a browser refresh, and a deep link all work: the Express catch-all
in `server/api.js` serves the admin SPA for `/trailers` and `/trailers/*`, and
the SPA resolves the section from the path. The build is shared with `/admin`
and `/dispatch`, which is only possible because Vite's `base` is `/admin/` — the
asset URLs are absolute, so the same `index.html` loads under any slug.

Back and forward move between sections: in-app navigation pushes a history
entry per section, and the shell re-reads the path on `popstate`.

### The old `/admin/trailers` URLs

They keep working. `/admin/trailers/...` still serves the SPA, which rewrites the
location to the matching `/trailers/...` URL with `history.replaceState` — a
replace, not a push, so Back does not bounce off the old URL. Nothing is lost in
the rewrite:

- the section, including pre-redesign section keys (`/admin/trailers/map`
  → `/trailers/trailers?tab=map`, `/admin/trailers/companies`
  → `/trailers/more?tab=companies`);
- the selected record and every filter in the query string.

`admin/src/pages/trailer/trailerNavigation.js` is the single source for this
mapping; every path helper there accepts either prefix.

### Signing in

A user sent to the login gate from a trailer URL returns to that exact page.
Accounts with only `trailer_*` permissions land in the department automatically —
at the page they asked for if there was one, otherwise at their default section.
Full administrators reach it from the normal admin sidebar (Operations → Trailer
Department), which expands to the sections they may open.

Trailer **Tracking** (`/admin`, Operations → Trailer Tracking) is a separate
operational monitoring feature and is unaffected by any of this.

## Feature flag

The rental and asset-management APIs are **enabled by default**. `TRAILER_DEPARTMENT_ENABLED` controls them:

| Value | Result |
| --- | --- |
| absent (or empty) | Enabled |
| `true` | Enabled |
| `false` | Disabled — the emergency kill switch |
| anything else | Disabled, with a configuration error logged (an explicit mistake fails closed) |

Setting `TRAILER_DEPARTMENT_ENABLED=false` makes every `/api/trailer-department/*` endpoint return `404 Trailer Department is disabled.` The single exception is `GET /api/trailer-department/status`, which stays available to authenticated admins and returns `{ "enabled": false }` so the admin panel can explain the state instead of showing a page full of failed requests.

A **server restart or redeploy is required** after changing the value — the flag is read once at boot. Production deployment and environment-variable changes remain manual.

While the flag is `false`, `/trailers` still loads: the shell shows the
disabled panel rather than a page of failed requests, so the kill switch is
visible instead of looking like an outage.

### Deployment

No Render environment-variable change is required to enable the department — an
absent `TRAILER_DEPARTMENT_ENABLED` means enabled. Two things are worth checking
once after a deploy:

1. If `TRAILER_DEPARTMENT_ENABLED` is currently set to `false` (or to any value
   that is not `true`/`false`) in the Render service, the department stays off.
   Remove the variable or set it to `true`, then restart. **Change this by hand
   in the Render dashboard** — deployment settings are never automated from this
   repository.
2. `/trailers` is served by the application, not by a static host, so no
   rewrite/redirect rule needs to be added anywhere.

Existing trailer tracking remains available under its current routes and permission gates.

## Authentication and browser security

Admin authentication remains a bearer token in the `Authorization` header. Tokens contain only the administrator ID, username, and `auth_version`; every authenticated request reloads the active account, roles, and permissions from PostgreSQL. Disabling an account, changing its password, or changing a role therefore takes effect immediately.

Authentication does not use cookies, so cookie-based CSRF does not apply. XSS and token leakage remain relevant: do not place tokens in URLs or logs, do not render untrusted HTML, and keep the existing output escaping and Content Security Policy controls in place.

## Private storage

Create a private Supabase Storage bucket named `trailer-private` (or the value of `TRAILER_STORAGE_BUCKET`) before enabling uploads. Configure these server-only values:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TRAILER_STORAGE_BUCKET`

Never expose the service-role key through the React build or a public environment variable. PostgreSQL stores bucket/object paths only. The API checks permissions and issues five-minute signed URLs.

## Manual rollout

1. Apply `database/schema.sql` and verify that every existing administrator has the `super_admin` role.
2. Sign in as `Trailer` with the initial password `Trailer123`, then change it through the authenticated password-change endpoint.
3. Create the private bucket and configure the server-only credentials.
4. Configure payment and overdue Telegram group IDs. Send a successful test to both groups before enabling reminders.
5. In staging, review one existing trailer as available and complete a pickup, return, invoice, receipt upload, payment, and reversal test.
6. Leave `TRAILER_DEPARTMENT_ENABLED` unset (or `true`) and monitor `trailer_notification_jobs` failures and `trailer_audit_log`. Set it to `false` and restart the server only to shut the department off.

Do not automate production environment-variable changes or deployment from this workflow.
