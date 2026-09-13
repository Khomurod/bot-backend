<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list. -->

# §5. Permissions and access rules

### Admin authentication

- `POST /api/auth/login` → bcrypt against `admins`, per-IP rate limiting, HS256
  JWT. **`authMiddleware` pins `algorithms: ['HS256']`** so an `alg:none` or
  asymmetric forgery cannot impersonate an admin.
- The token carries only admin id, username and `auth_version`. **Every
  authenticated request reloads the account, roles and permissions from
  PostgreSQL**, so disabling an account, changing a password, or changing a role
  takes effect immediately. An `auth_version` mismatch invalidates the session.
- The frontend stores the token in `localStorage`. Auth is header-based, not
  cookie-based, so cookie CSRF does not apply; XSS and token leakage do. Never
  put a token in a URL or a log.

### Role-based access control (this replaced the old "any admin can do anything")

`roles`, `permissions`, `role_permissions`, `admin_user_roles`. Built-in role
key: `super_admin` — the only built-in role left, now that the four
`trailer_*` roles are gone. Custom roles always get a `custom_`
prefixed key and may never claim a reserved key or `super_`/`admin_` prefix
(`lib/rbac/roleKeys.js`).

- **`admin.full_access`** is the gate for the whole company-wide admin API. In
  `server/api.js` most routers are mounted behind
  `legacyAuthMiddleware = [authMiddleware, requirePermission('admin.full_access')]`.
- **`requirePermission` / `requireAllPermissions` are still per-permission
  gates** (`server/middleware/auth.js`), and `roles`/`permissions` are still
  database-backed and admin-editable. What is gone is the only feature that
  used a *partial* scope: the Trailer Department. `admin.full_access` is now
  the single gate for every section, and an account without it has nothing it
  can open — the admin SPA says so plainly instead of rendering a page whose
  every request would 403.
- **`operations.corrections.apply` is the one narrower permission** (migration
  0018), and the first the application has had since the Trailer Department went
  away. It exists because Needs Attention is the first page where *reading* and
  *acting* are genuinely different acts: a finding says "these two facts of ours
  disagree, here is the evidence", while applying one closes a driver's home-time
  cycle or flips their status. `server/routes/operations/correctionsRoutes.js`
  requires it **INSTEAD of** `admin.full_access`, never OR'd with it — an OR
  would grant it to everyone who can open the page and separate nothing. Reads,
  dismissals, snoozes and on-demand sweeps stay on the blanket gate, because none
  of them can alter a driver record.
  - The nav still has no per-item permission field, so a role with
    `admin.full_access` but not this one sees the page and gets a 403 with a
    readable explanation from the apply buttons. That is deliberate for now:
    hiding the page would also hide the evidence, and the evidence is the part
    everyone should be able to read.
  - **A new permission must be back-filled to `super_admin` in the same
    migration.** `database/baseline/022_rbac_and_admin_users.sql` CROSS JOINs
    every permission to that role at SEED time only, so one added later is held
    by nobody — a migration that inserts the permission row and stops locks every
    existing administrator out of the feature it was written to enable, and looks
    entirely correct in review. `tests/operationsCheckSettingsPg.test.js` pins it.
- **There is no longer a partially-scoped user administrator.** A Trailer
  Manager (`trailer_users.manage` without `users.manage`) used to see and edit
  only trailer-only accounts, with out-of-scope targets answering 404 rather
  than 403 so their existence could not be inferred. That scoping went with
  the feature; `server/routes/adminUserGuards.js` is what remains, and it
  keeps the guard that was never about trailers:
- **The last active super administrator cannot be deactivated or demoted.**

### Non-JWT access paths (be careful changing these)

| Path | Gate |
|---|---|
| `/raise/*`, `/api/raise/:token/*` | Per-**round** token (expiring) + per-team OTP, used by dispatchers |
| `/recruiters`, `GET /api/recruiters/public-stats` | Public; names + KPI numbers only |
| `/employee-birthday-form`, `POST /api/submit-employee-birthday` | Public form |
| `/facebook/connect/:sessionToken`, `/facebook/oauth/*` | Session token |
| `/ringcentral/connect/:sessionToken`, `/ringcentral/oauth/*` | Session token — single-use, 30-minute `ringcentral_connect_sessions` row; `oauth_state` binds the redirect to the callback. Public because a recruiter has no admin session |
| `ALL /webhook`, `ALL /rc-webhook` | Raw-body proxied to the Python worker; signature verified there |
| `/api/internal/*` | `internalSharedSecretGuard` (`LEADS_INTERNAL_SHARED_SECRET`) |
| `/api/route-screenshot-media/:id` | Short-lived HMAC-signed URLs (Telegram has no session) |
| `POST /api/dat-ui/inspect` | Loopback only |
| `/`, `/health`, `/api/health`, Meta compliance pages (`/privacy-policy.html`, `/terms-of-use`, `/user-data-deletion`) | Public |
| `/presentation`, `/presentation/*.css`, `/presentation/*.js` | Public — the **owner-facing product deck**, served from an explicit asset allow-list in `healthRoutes.js` |
| `/remote`, `/remote/remote.css`, `/remote/remote-*.js` | Public — the **presenter remote** for the Wenzel Weekly Report deck. Pairing is the four-digit code the deck itself displays; the page reaches no API on this server and no company data (§4). Explicit allow-list, not a static mount |

Everything else under `/api/*` requires the admin JWT.

### Telegram-side authorization

Numeric user IDs are the only stable Telegram identity — usernames are
reassignable. The creator panel checks a hardcoded numeric `CREATOR_USER_ID`
(`bot/creatorMessageManager.js`), and new gates should be ID-only.

**Two existing gates use a documented ID-or-username pattern** — know this before
you assume either is ID-only:

| Gate | Behavior |
|---|---|
| Mileage-bonus Paid/Rejected (`services/mileageBonusConstants.js` `isAccountingUser`) | checks `MILEAGE_BONUS_ACCOUNTING_USER_IDS` **only if that list is non-empty**; otherwise falls back to a username allow-list with hardcoded defaults |
| Home-time managers (`services/homeTimeRequestConstants.js` `isHomeTimeManager`) | **recognition, not authority** — home time is reported, never approved, so nothing is gated on being a manager. The list is the three built-in managers, plus anything in `HOME_TIME_MANAGER_USERNAMES` / `_USER_IDS` (or the retired `HOME_TIME_APPROVER_*` names); an override ADDS people and can never drop one |

Both are deliberate: *"once immutable IDs are configured, usernames no longer
grant authority."* Configuring the IDs in the environment is what hardens them.

**The control channel is ID-only and always was.** `control_operators`
(migration 0048) is the allow-list that decides whose reply in the notifications
group Wenze obeys — the one Telegram gate that can change operational state.
Numeric ids only; the route refuses anything that is not a number, and a
username-keyed allow-list would hand the channel to whoever claims that name
next. It is seeded with `CREATOR_USER_ID` and nobody else, membership is
managed from Settings → Telegram groups with every change audited, and the last
enabled operator cannot be removed. Being in the group — or being a Telegram
admin of it — grants nothing. See
[`docs/architecture/control-channel.md`](../architecture/control-channel.md).

A correction applied this way is attributed `telegram:<id>`, a third initiator
form beside `admin:<id>` and `system`. It counts as a person, which is what
gets an approval-tier correction past the schema's system-is-auto-only CHECK.

**An answer an operator gives can outlive the reply, and it is still not a
permission.** A "no" is stored in `control_knowledge` and re-applied to the same
condition by the sweep, attributed to the operator who gave it. A remembered
"yes" is never re-applied: permission for Wenze to act by itself lives in
**`/api/finance` is the one route family that returns captured payment text.**
Everything else in the Finance Monitor — the settings API, the `/api/health`
block, the weekly report — answers with counts on purpose. That router is
behind the same admin gate as the settings API, refuses an unauthenticated call
before touching the database, and writes no business value: its three actions
re-run machinery that already exists — re-read a message with the current
parser, queue an attachment again, send the weekly summary now — and take no
amount, code or status from the caller. A manual send is recorded as `manual`,
which the partial unique index excludes, so it never stands in for Monday's. See `docs/architecture/finance-monitor-page.md`.

`operational_check_settings.mode`, changed by an administrator on the Automation
screen under `operations.corrections.apply`. Revoking a memory is an
`admin.full_access` action on Settings → Answering Wenze in Telegram, audited as
`control_knowledge.revoke`.
Do not copy the username fallback into new code, and do not describe either gate
as ID-only.

---

### Removed features' URLs

`/trailers*`, `/questions*`, `/answers*` and `/qbq*` answer **410 Gone** with a
short "this feature has been removed" page (`server/routes/retiredRoutes.js`),
mounted immediately before the admin SPA catch-all so any surviving route still
wins. They used to resolve to the SPA shell, which would now render an empty
section. Removed `/api/*` endpoints simply 404, which is the right answer for a
JSON client.

Old Telegram buttons need no equivalent: **neither removed feature ever
produced an inline keyboard**, and the `callback_query` catch-all in
`bot/handlers/surveyCallbackHandlers.js` already acknowledges unknown callback
data without erroring.
