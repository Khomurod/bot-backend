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

### Who may hold and move roles (October 2026 audit)

- **No account without a role.** `PUT /api/admin/users/:id` refuses an empty
  `role_ids` (400 `ROLE_REQUIRED`); to stop someone signing in, disable the
  account. A role-less account is a trap: the boot-time grant in baseline 022
  gives it `super_admin`.
- **That boot-time grant is a first-run bootstrap only.** It fires only while
  there is NO active super administrator (the admins that existed when roles
  arrived, an empty database, or every super administrator disabled). Until
  October 2026 it ran on every boot for ANY role-less account, so stripping an
  account's roles to lock it out made it super administrator at the next
  deploy. The fix had to be in the baseline statement itself — it runs on every
  boot, and no forward migration can change what it does — and
  `tests/adminRoleBootstrapPg.test.js` proves both halves.
- **Only a super administrator touches super administrators**: granting
  `super_admin`, and changing a super administrator's account in any way —
  roles, password, disabling, renaming (403 `SUPER_ADMIN_ONLY`). Otherwise
  `users.manage` alone could make anyone super administrator, or reset a
  super administrator's password and sign in as them. Ordinary accounts stay
  with `users.manage`. The route answers first
  (`adminUserGuards.assertAccountChangeAllowed`, on snapshots), and
  `rbac.createAdminUser` / `rbac.updateAdminUser` repeat the rule inside their
  transaction on LOCKED rows — the target's, and the acting account's own,
  whose roles are read again there (both rows locked in id order, so two
  administrators editing each other cannot deadlock). A concurrent edit, or the
  actor being demoted or disabled while their request is in flight, cannot make
  a stale snapshot pass.
- **`npm run seed-admin` needs `ADMIN_PASSWORD` of at least 10 characters**
  and refuses before touching the database otherwise; it used to create the
  first admin with an empty password, which sign-in refuses. A new account is
  given `super_admin` by the script itself (`grantSuperAdminIfRoleless`); an
  existing one keeps its password and roles.

### Admin accounts have a screen (October 2026)

**Settings → Administration → Admin Accounts** (`admin/src/pages/settings/admins/`)
is the screen for `server/routes/adminUserRoutes.js`, which had existed with no
caller: list every account with its roles, state and last sign-in; create one
(username, a password of at least 10 characters typed twice, at least one active
role); **disable / re-enable** it; **reset its password**. Disable and reset
bump the account's `auth_version`, so that person's sessions end at once. The
server's guard stays the only authority on "the last active super administrator
cannot be disabled or demoted" (`adminUserGuards.js`, `database/rbac.js`); the
screen shows its refusal, under the row that was pressed. A username already in
use is a 409 "That username is already taken." (`USERNAME_TAKEN`, on create and
on rename), not a 500. Your own row has neither action: disabling yourself
locks you out mid-task, and a new password for yourself belongs behind your
current one — **Change password** in the sidebar footer
(`POST /api/auth/change-password`), open to every signed-in account including
one without `admin.full_access`; success ends the session and offers the
sign-in screen. The screen needs `users.manage`; an account without it is told
so in words. **Not on a screen yet:** changing an existing account's roles and
editing roles and their permissions (`POST`/`PUT /api/admin/roles`).

### Non-JWT access paths (be careful changing these)

| Path | Gate |
|---|---|
| `/raise`, `/raise/*` | **Retired** (October 2026): answers 410 Gone from `server/routes/retiredRoutes.js`; `/api/raise/*` is unmounted and 404s |
| `/recruiters`, `GET /api/recruiters/public-stats` | Public; names + KPI numbers only |
| `/dispatch`, `/dispatchteam`, `GET /api/gross-race` | Public; dispatcher and team names + race numbers only. A driver's name only on the teams' board and only once their truck has hit its weekly target; never the Datatruck token (`docs/architecture/gross-race.md`) |
| `/employee-birthday-form`, `POST /api/submit-employee-birthday` | Public form |
| `/facebook/connect/:sessionToken`, `/facebook/oauth/*` | Session token |
| `/ringcentral/connect/:sessionToken`, `/ringcentral/oauth/*` | Session token — single-use, 30-minute `ringcentral_connect_sessions` row; `oauth_state` binds the redirect to the callback. Public because a recruiter has no admin session |
| `ALL /webhook`, `ALL /rc-webhook` | Raw-body proxied to the Python worker; signature verified there |
| `/api/internal/*` | `internalSharedSecretGuard` (`LEADS_INTERNAL_SHARED_SECRET`) |
| `POST`/`GET /api/integrations/bitrix/home-time-violation` | `?token=` compared in constant time with the secret created on the Home Time page (stored encrypted; `HOME_TIME_VIOLATION_WEBHOOK_SECRET` is the fallback); unset → refused. Takes only a deal id, re-reads the card from Bitrix, answers 202 (`docs/architecture/home-time-violation-alerts.md`) |
| `/`, `/health`, `/api/health`, Meta compliance pages (`/privacy-policy.html`, `/terms-of-use`, `/user-data-deletion`) | Public |
| `/presentation`, `/presentation/*.css`, `/presentation/*.js` | Public — the **owner-facing product deck**, served from an explicit asset allow-list in `healthRoutes.js` |
| `/remote`, `/remote/remote.css`, `/remote/remote-*.js` | Public — the **presenter remote** for the Wenzel Weekly Report deck. Pairing is the four-digit code the deck itself displays; the page reaches no API on this server and no company data (§4). Explicit allow-list, not a static mount |

Everything else under `/api/*` requires the admin JWT.

### Telegram-side authorization

Numeric user IDs are the only stable Telegram identity — usernames are
reassignable. The creator panel checks a hardcoded numeric `CREATOR_USER_ID`
(`bot/creatorMessageManager.js`), and new gates should be ID-only.

**Two existing gates — know how each one decides before you assume:**

| Gate | Behavior |
|---|---|
| Mileage-bonus Paid/Rejected and home-time violation Charged / Not charging (`services/mileageBonusConstants.js` `isAccountingUser`) | **ID-only since 21 October 2026**: `MILEAGE_BONUS_ACCOUNTING_USER_IDS`, defaulting to the two accountants' Telegram ids (Cameron 6504395610, Ella 8245947790). The username list is still exported for mentions, but no longer grants authority |
| Home-time managers (`services/homeTimeRequestConstants.js` `isHomeTimeManager`) | **recognition, not authority** — home time is reported, never approved, so nothing is gated on being a manager. The list is the three built-in managers, plus anything in `HOME_TIME_MANAGER_USERNAMES` / `_USER_IDS` (or the retired `HOME_TIME_APPROVER_*` names); an override ADDS people and can never drop one |

Both are deliberate: *"once immutable IDs are configured, usernames no longer
grant authority."* The accounting gate has its ids built in; the managers' list
is hardened by configuring theirs.

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
The same allow-list decides whose plain-words answer to an AI learning question
becomes a lesson ([`ai-learning.md`](../architecture/ai-learning.md)); a
stranger's answer is consumed and never kept.

A correction applied this way is attributed `telegram:<id>`, a third initiator
form beside `admin:<id>` and `system`. It counts as a person, which is what
gets an approval-tier correction past the schema's system-is-auto-only CHECK.

**An answer an operator gives can outlive the reply, and it is still not a
permission.** A "no" is stored in `control_knowledge` and re-applied to the same
condition by the sweep, attributed to the operator who gave it. A remembered
"yes" is never re-applied: permission for Wenze to act by itself lives in
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
