# Trailer Department operations

The rental and asset-management APIs are disabled unless `TRAILER_DEPARTMENT_ENABLED=true`. Existing trailer tracking remains available under its current routes and permission gates.

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
6. Enable `TRAILER_DEPARTMENT_ENABLED` manually and monitor `trailer_notification_jobs` failures and `trailer_audit_log`.

Do not automate production environment-variable changes or deployment from this workflow.
