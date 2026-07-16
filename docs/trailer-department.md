# Trailer Department operations

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
