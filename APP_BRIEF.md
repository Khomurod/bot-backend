# APP BRIEF — Wenze Trucking Operations Hub (`bot-backend`)

**This is the central brief for this application. Read it before any task, then
verify the specific parts you touch against the current source.** It is written
so an AI agent can build an accurate mental model in one read. It is deliberately
not exhaustive: it explains *what exists, why, and what must not break*, and
points at the code that holds the detail.

Companion documents: `CLAUDE.md` (mandatory working rules and per-feature
invariants — read it too), `README.md` (setup/endpoint reference),
`docs/` (deep dives, database reference, archived-feature records).

*Every claim below was verified against the code on **2026-08-13**. If you are
reading this much later, treat the specifics as likely-but-unconfirmed and
re-check what your task depends on — then update the date when you do.*

**How to read it:** §1–§3 (purpose, topology, users) and **§9 (what must not
break)** are worth reading every time — they are short and they are where the
expensive mistakes live. Then jump to the section covering your task. §10 lists
the traps, retired features and stale docs; §12 is the file map.

---

## ⚠️ PERMANENT RULE — This brief is a living document

**Keeping this brief true is part of every task, not a separate chore.**

1. **Before changing anything**, read the relevant sections here, then verify
   them against the current code. This brief can drift; the source is the truth.
   If you find drift, fix the brief as part of your task.
2. **After completing any** feature, bug fix, adjustment, removal, behavioral
   change, integration change, workflow change, permission change, or schema
   change — **re-read this brief** and ask: *does it still describe the
   application accurately?*
3. **If your work changed anything described here, update that part in the same
   task.** If you introduced an important behavior, rule, dependency,
   integration, exception, or decision, add it where it belongs. If something
   described here was removed or is no longer true, correct or delete it.
4. **A task is NOT complete while this brief says one thing and the application
   does another.** Treat a stale brief exactly like a failing test.
5. **Keep it useful.** Do not add minor implementation details, line numbers,
   function signatures, or anything that will rot without adding understanding.
   Add a fact here only if a future agent would make a mistake without it.

The same applies to the per-feature invariants in `CLAUDE.md` — if you change a
behavior it guards, update it there too.

---

## 1. App purpose

A **trucking operations and driver-communication platform** for **Wenze
Investments**, a US trucking company. It is the company's internal operations
hub, and almost everything it does reduces to one of two actions:

- **send/receive Telegram messages to and from driver and staff groups**, or
- **read/write the shared PostgreSQL database.**

Follow those two threads and you will find any feature.

Business problems it solves:

- Communicate with drivers at scale, in their own language (EN/RU/UZ), through
  the Telegram groups they already live in.
- Give dispatch real-time truck location, load and ETA information.
- Automate recurring operations work: bonuses, raises, home-time, fuel stops,
  document forwarding, off-route warnings, birthday wishes.
- Capture and convert recruiting leads (Facebook/Meta, Indeed) and measure
  recruiter performance.
- Run the **Trailer Department** — a real rental business that rents company
  trailers to outside carriers, with agreements, inspections, invoices and
  payments.

---

## 2. Deployment topology and processes

`render.yaml` defines two Render services in this repo; a third lives elsewhere.

| Service | Repo | What it is |
|---|---|---|
| `driver-feedback-bot` | this repo | `index.js` — the whole Node app: Telegram bot + Express API + admin SPA + all background jobs |
| `facebook-leads-engine` | this repo (`leads-bot/`) | Python FastAPI lead worker. In the main deployment `index.js` **spawns it as a child process**; it can also run standalone |
| Samsara safety poller | **separate repo** `Khomurod/samsara-integration` | Polls Samsara safety events → dashcam alerts to Telegram |

The three cooperate in **two different ways** — do not confuse them:

- **Node hub ↔ Samsara service: shared PostgreSQL only.** Same `DATABASE_URL`,
  no in-process link and no HTTP link between them. The Samsara service reads
  `groups` for driver-group routing and the safety-event video/music settings this
  repo manages, and writes `safety_event_video_jobs`.
- **Node hub ↔ Python leads worker: internal HTTP only.** The worker has **no
  database access whatsoever** — no Postgres driver in
  `leads-bot/requirements.txt`, no `DATABASE_URL` (and `render.yaml` does not
  give it one). It calls the hub at `LOCAL_API_BASE_URL` with
  `LEADS_INTERNAL_SHARED_SECRET`, and the hub proxies `/webhook` + `/rc-webhook`
  to it. **All lead persistence happens on the Node side.**

Hard constraints of this deployment:

- **Memory-constrained.** The Node process runs with `--max-old-space-size=256`
  on a 512MB instance, `MALLOC_ARENA_MAX=2`, and a Postgres pool of `max=5`.
  Avoid buffering large files, unbounded caches, and new always-on intervals.
  `services/memoryWatchdog.js` can log pressure but is **off unless
  `MEMORY_WATCHDOG_ENABLED='true'`**.
- **The Samsara poller was moved out of this process on purpose** — it caused
  OOM kills. **Do not re-add it here.** The live-GPS lookup that remains in this
  app is a different, much smaller thing and must keep working. See
  `docs/architecture/samsara-separation.md`.
- **All Telegram traffic is pinned to IPv4** via `services/telegramAgent.js`.
  The host's IPv6 path to `api.telegram.org` black-holes multi-packet upload
  bodies. **Do not remove that agent.**
- The Python child is supervised with exponential-backoff restart and a
  **circuit breaker** (5 crashes in 3 minutes → stop restarting; exit code 78 =
  permanent config error, never restarted).
- `main` auto-deploys to Render. **Pushing a feature branch to this repository
  auto-opens AND auto-merges a PR into `main` within seconds — review the
  complete diff BEFORE pushing** (`CLAUDE.md`).

### The Telegram bots

| Bot | Token env | Role | Owner |
|---|---|---|---|
| Wenze Support / feedback bot | `BOT_TOKEN` | Main bot: feedback, broadcasts, dispatch commands, Route Control, trailer monitor, creator panel | this repo, `bot/` |
| Wenze lead bot | `TELEGRAM_BOT_TOKEN` | Facebook/Indeed leads, auto-SMS, RingCentral replies | `leads-bot/` + `services/leadsTelegramClient.js` |
| Samsara notification bot | `SAMSARA_BOT_TOKEN` (in the other repo) | Dashcam safety alerts | `samsara-integration` |

- **Only long-polling must be exclusive** — a token may be *sent* on from
  anywhere, but only one process may `getUpdates` it. Two pollers on one token
  produce a permanent Telegram 409 conflict loop, so
  `assertDistinctTelegramPollingTokens()` in `index.js` refuses to boot if
  `BOT_TOKEN === TELEGRAM_BOT_TOKEN`.
- Consequently: the **Python worker polls** `TELEGRAM_BOT_TOKEN` while Node only
  *sends* on it (`services/leadsTelegramClient.js`), and the **Samsara service
  sends** on the hub's `BOT_TOKEN` (to post into driver groups) while only the
  hub polls it. Both are safe; adding a second poller anywhere is not.
- `@datatruck_driver_bot` is a **third-party** bot ours only reacts to
  (`bot/datatruckPeerHandlers.js`).

---

## 3. Main users

| User type | How they use it |
|---|---|
| **Drivers** | Their Telegram driver group is the whole interface: answer surveys, post `Status: Home/Ready/Rolling`, request home time, receive broadcasts, bonuses, route/off-route warnings, BOL/POD documents, fuel reminders. Also anonymous feedback in the bot's private chat. |
| **Dispatchers** | `/load`, `/location`, `/status`, `/update` inside driver groups; assign Google Maps routes (Route Control) by pasting a directions link; receive automatic ETA updates; submit their team's weekly driver-raise picks through the public raise link. |
| **Admins / office staff** | The admin SPA at `/admin`: broadcasts, surveys, groups, leads, live map, home time, fuel, mileage bonuses, raises, recruiter KPIs, settings. |
| **Trailer Department staff** | `/trailers` — the rental business UI, scoped by `trailer_*` permissions. Roles: manager, employee, accounting, viewer. |
| **Accounting** | Mileage-bonus Paid/Rejected buttons in Telegram (allow-listed accounting users — see §5); trailer invoices/payments in the SPA. |
| **Recruiters** | Measured, not users: RingCentral call logs feed KPIs and the public `/recruiters` leaderboard. |
| **Company employees (all departments)** | The public QBQ/SOS assessment at `/questions` and `/answers`. |
| **The owner ("creator")** | A Telegram-only messaging panel in the bot's private chat, gated on one numeric user ID (`CREATOR_USER_ID` in `bot/creatorMessageManager.js`). |

---

## 4. Main features and workflows

### Driver communication

- **Surveys / feedback** — admin creates a question, `translationService` produces
  EN/RU/UZ, it is sent to groups by language, answers are relayed to the
  management group in English. **Answers are multiple-choice only**: `responses`
  stores an `option_id` and has no text column, so a question must have options
  and a driver answers by tapping an inline button. Deduped by a unique index on
  `(driver_id, question_id)`. Free-text driver input reaches the company through
  the separate anonymous-feedback flow, not surveys.
- **Broadcasts** — targeting via `services/broadcastTargetService.js`
  (`all`, `language_groups`, `specific_drivers`, `company_drivers`, `employee`,
  `other_company`, plus an active filter), media via staged Telegram `file_id`s,
  placeholders via `broadcastTemplateService.js`, per-group results in
  `broadcast_deliveries`.
- **Scheduled messages** — one-time or weekly, Central Time (Luxon);
  `schedulerService.js` claims due rows and reuses the broadcast path.
- **Creator panel** — private chat, one allow-listed user ID: pick an audience or
  a single group; any content is delivered **verbatim** via `copyMessage`.
- **Message Manager / Bot Messages** — every outbound send is recorded in
  `bot_sent_messages` by `services/botSentMessageRegistry.js`, which patches
  `telegram.callApi` and logs the result **after** the send. It is an
  after-the-fact ledger, not a guard: it powers the admin edit/delete surface and
  resolves a creator's forwarded message back to the original send, but it does
  **not** prevent duplicate sends — per-feature claim/dedupe ledgers do that (§7).
- **Auto-reactions** — per-user/username emoji reaction rules, cached in memory,
  strictly best-effort (`services/autoReactionService.js`).
- **Anonymous feedback** — private chat flow that relays a complaint to a group
  with **no** identifying information.

### Dispatch and location

- **Group commands** `/load`, `/location`, `/status`, `/update` resolve live GPS
  and the current load (Datatruck → pinned message → chat history fallbacks).
- **ETA updates** — `dispatchEtaUpdateService.js` claims per-group rows with
  `FOR UPDATE SKIP LOCKED` and pushes periodic ETA messages.
- **Live Locations** — authenticated admin map (`liveLocationsService.js`); map
  tile URL is served only to logged-in admins, never baked into the bundle.
- **Route Control** (`services/routeControl/`) — a dispatcher pastes a Google
  Maps directions link into a driver group; the app parses it, computes route
  geometry (Google Routes API), posts a route message (with an optional
  screenshot), then compares live GPS to the route:
  - **Destination auto-completion** runs for **every** lifecycle-active route
    (including tracking-pending) and does **not** require Google Maps to be
    enabled. Completion is silent and atomic.
  - **Off-route warnings** require Settings → GMaps `enabled` **and**
    tracking-active.
  - See `CLAUDE.md` for the full invariant, including the signed-URL screenshot
    transport that must never become a direct byte upload.
- **Duplicate unit check** — every 15 minutes, scans active driver groups for
  duplicate unit numbers and Samsara driver-name mismatches, and stores findings
  in `duplicate_unit_reports`. It **deliberately never messages driver groups.**

### Payroll-adjacent workflows (real money — change carefully)

- **Mileage bonus** — miles come from Datatruck; a crossed milestone posts a
  notification with **accounting-only** Paid/Rejected buttons. **Two different
  ledgers, do not confuse them**: the milestone is deduped by
  `mileage_bonus_notifications` UNIQUE `(driver_normalized_name,
  threshold_miles)` (`claimBonusNotification()` relies on it as *the*
  idempotency guard), while `mileage_bonus_runs` only makes the weekly service
  **run** itself leased and retryable.
- **Driver raise review** — decides whether a company driver earns `rate_high`
  instead of `rate_low` for a pay period (defaults 0.750 / 0.720 per mile, both
  configurable in `raise_settings`). **This is a dispatcher workflow, not a driver
  one:**
  - One open round at a time. Each round mints **one** `raise_rounds.access_token`
    (default 48h TTL) and the service posts that single link to the configured
    Dispatch Rate Review Telegram group.
  - **TWO independent Telegram destinations, two audiences** — both admin-set in
    Settings → Telegram Groups, and **neither is a fallback for the other**:
    the review **request** (weekly and "Send now") goes only to
    `dispatch_review_group_id`; the **submitted result** — who moves to
    `rate_high`, who stays at `rate_low`, with team, submitter and pay period —
    goes only to `raise_results_group_id` (accounting). Posting a pay decision
    back to the dispatch group was the old behavior and must not return. An admin
    *may* enter the same ID in both; the application must never do it for them.
    A missing **request** group is a hard error: no round is opened, nothing is
    sent. A missing **results** group never costs a submission — the response is
    saved, one clear `[RAISE]` configuration error is logged, `submitResponse`
    reports `results_posted: false` with a `results_notice`, and nothing is
    re-sent or retried (a retry could duplicate the notification).
  - A **dispatcher** opens the link, selects their dispatch team, enters their own
    contact, and verifies an OTP (channel is `raise_settings.otp_channel`: Gmail
    App Password or RingCentral SMS) before submitting their team's picks.
  - **One submission per team per round** (a second attempt gets 409). Drivers
    never open this page and never receive an OTP.
  - An admin closes the round from `/api/raise/admin/*`.
- **Road / extra-week bonus** — posted as **one summary at the road→home
  transition**, never week-by-week. Company drivers only (owner-operators earn
  $0). Claimed atomically per completed leg in `driver_road_history`, with a
  background poller as a retry safety net.

### Driver home time

- Driver-group messages containing `Status: Home / Ready / Rolling` drive a
  per-group home/road state machine (`homeTimeService.js`) — event-driven, no
  timer.
- Missing dates trigger a clarification flow with **exactly two** reminders
  (default 12h apart), atomically claimed so a restart can never double one;
  after the second unanswered reminder the flow is flagged for manual follow-up.
- Reminders respect the driver-messaging switch
  (`home_time_settings.driver_clarification_enabled`).
- Home-time **requests** from drivers get Approve / Do-Not-Approve buttons gated
  on the approver allow-list (see the authorization note in §5 — usernames by
  default, numeric IDs once configured).

### Fuel monitor

The fuel team posts a gas-station location into a driver group → a watch row is
recorded → a poller waits until the truck is within `radius_miles` → it replies to
the original message tagging the driver. Detection is cheap-first (most messages
never reach an AI call).

### Recruiting and leads

- **Facebook/Meta leads**: Meta → `POST /webhook` (raw-body proxy, Node) →
  Python worker verifies `X-Hub-Signature-256` → posts verified events back to
  `/api/internal/facebook/webhook-events` (shared secret) →
  `facebookWebhookService.js` queues and dedupes (`facebook_webhook_events`,
  key `leadgen:<pageId>:<leadgen_id>`) → fetches the lead via Graph → formats →
  posts to the leads Telegram group → fires auto-SMS → mirrors SMS replies
  two-way → creates a Bitrix24 CRM lead (best-effort; CRM failure never blocks
  the Telegram post).
- **Self-serve Page connect**: `/connect` in a leads group starts a
  session-token-gated OAuth flow; Page tokens are encrypted
  (`services/facebookCrypto.js`).
- **Indeed leads** arrive from a Gmail Apps Script
  (`docs/gmail-indeed-apps-script.gs`) to `/api/internal/indeed/lead`.
- **Recruiter KPIs**: RingCentral call logs sync into `ringcentral_calls`. The
  targets are configurable defaults (`ringcentral_settings`): 2h30m of real talk
  time per day, 150 outbound calls/day, and calls shorter than 30s do not count
  as valuable. The score weights talk time 70% / outbound 30%. Public leaderboard
  at `/recruiters` exposes names and KPI numbers only — **never phone numbers**.

### Trailer Department (rental business) — `/trailers`

**This is a business, not a monitoring tool.** Wenze rents its trailers to
outside carriers. Distinct from Trailer Tracking below.

- **Multi-trailer agreements**: `trailer_rental_agreements` is the header,
  `trailer_rental_items` is one row per trailer, each with its own
  pickup/return/pricing. Agreement status is **derived** from item statuses by a
  pure function and re-derived in the **same transaction** as every item change —
  never set directly.
- **History is amendment-based**: add/remove/replace/rate/amount/extend append an
  immutable `trailer_rental_amendments` row. There is no amendment update path.
- **Availability is enforced in the database**: an EXCLUDE-gist overlap
  constraint (`trailer_rental_items_no_overlap`) plus a partial unique index
  `uniq_trailer_item_one_active` on `(trailer_id) WHERE item_status = 'active'`.
- **`assertTrailerAvailable` is the one CROSS-SYSTEM booking gate**
  (`database/trailerAvailability.js`). The per-table constraints cannot see each
  other, so nothing stopped one trailer being booked in the legacy
  `trailer_rentals` **and** in `trailer_rental_items` at the same time. Every
  booking/scheduling/activation path in **either** system must call it before
  committing — a new booking path that skips it reintroduces double-booking.
- **Inspections** require photos and complete only through `completeInspection()`,
  which verifies both metadata and bytes inside a transaction — so a failed
  upload can never leave a completed inspection.
- **Invoicing** writes `trailer_invoice_lines` (immutable once finalized;
  corrections via adjustments/credits) and maintains the legacy
  `trailer_invoices` totals so existing readers keep working.
- **Payments**: overpayments are rejected unless the caller holds
  `trailer_payments.record_overpayment` and confirms; the excess is banked as a
  company credit and applied through an audited ledger.
- **Notifications**: payment and overdue messages to configured Telegram groups,
  via a job queue with snooze/resume semantics.
- **Feature flag** `TRAILER_DEPARTMENT_ENABLED` is the emergency kill switch:
  absent or `true` = enabled, `false` = disabled, **anything else = disabled with
  a logged config error** (an explicit mistake fails closed). Read once at boot —
  a restart is required. While off, `/trailers` still loads and shows a disabled
  panel instead of a page of failed requests, and
  `GET /api/trailer-department/status` stays available so the UI can explain.
- Legacy `/admin/trailers/*` URLs keep working and are rewritten in place to
  `/trailers/*` (`admin/src/pages/trailer/trailerNavigation.js` is the single
  source for that mapping).

### Trailer Tracking (Beta) — a separate feature

AI monitoring of trailer mentions in driver-group messages, plus a trailer map
and master list.

**`trailers` is the single authoritative master list, and "official" means
`active AND master_status = 'active'` — both must hold.** `active` keeps its
legacy soft-delete meaning and is deliberately *not* mirrored from
`master_status`. Pending-review, archived and merged trailers keep all their
history but must never appear on a map, in a default list, or in a rental picker.

The detection pipeline (`services/trailerMonitorService.js` +
`services/trailerMonitor/`) is: cheap keyword/unit candidate filter → context
collection → deterministic extraction → **mandatory** AI semantic verification
(completed past action vs. plan/instruction/question, EN/RU/UZ) → hard
server-side approval gate → register only **confirmed completed** actions.

**It fails closed**: if AI is unavailable, times out, or returns invalid JSON,
the candidate goes to the Needs Review ledger and the Automatic Updating (Test)
group — no status change, no driver reply.

### QBQ / SOS employee assessment and presentation

- **Assessment**: public questionnaire at `/questions` and anonymous aggregates
  at `/answers`, in UZ/RU/EN, scoring six thinking patterns
  (`victim, complaint, waiting, blame, ownership, builder`) with deterministic
  tie-breaking.
- **The answer options are written to be un-gameable, and that is a hard
  requirement, not a style preference** (`CONTENT_VERSION = 2`). All five options
  in every question must read as competent, professionally defensible and
  genuinely choosable; the six patterns differ by the person's **locus of first
  action**, never by one option sounding morally superior. The key must not be
  recoverable from the SHAPE of the options either — no phrase, no length
  pattern and no tone may belong to a single pattern inside a department. This is
  enforced by `tests/sosAnswerKeyLeakage.test.js` (lexical monopolies, longest /
  shortest-option distribution, banned self-pitying tone, and per-question guards
  that keep a safety hold or an out-of-service unit in **all five** options).
  Rewriting content here means re-running that suite, not just `validateContent`.
- **Bump `CONTENT_VERSION` when a rewrite changes what an option key MEANS**, not
  only when keys or pattern mappings change: a page held open across the deploy
  would otherwise show old wording and be scored against new semantics.
  `submitAssessment` rejects a stale version with `STALE_CONTENT` (409) and the
  page reloads. Stored submissions keep their own `content_version`, option keys
  and computed result forever — but the admin detail view resolves those keys
  through the CURRENT modules, so **read `content_version` before quoting an old
  answer verbatim**.
- **`/answers` is ONE company-wide result view.** Per pattern it shows the share
  of RESPONDENTS whose **primary** pattern it is (`people with that primary /
  total respondents`, each row rounded on its own — never a share of individual
  answers), the head count behind that share, and a short **authored** example
  quote from `content/results/*.js` (`exampleThought`) — never a submitted
  answer. **Department and dispatch-team results are deliberately absent from the
  public surface**: no per-group counts or pattern breakdowns, no question
  distributions, no ranking between groups. `getSummaryRows` selects exactly one
  column (`primary_pattern`), so the public payload has no group data to hide;
  the underlying rows are untouched and remain available through the admin API.
- **The public surface is aggregate-only, with one deliberate exception**: a
  submitter can re-view **their own** result via `GET /api/sos/results/:token`
  (32-hex token; the `/api/sos/test/...` twin 404s on a real token and vice
  versa). **Cross-person data — the submissions list, per-answer detail, names,
  CSV export and deletion — is admin-only** (`/api/sos/admin/*`).
- **A fully isolated TEST mode** (`/questions/test`, `/answers/test`,
  `/api/sos/test/*`) is the same router factory with one mode flag; isolation is
  enforced in SQL (`is_test`). Clear-test and clear-real are separate admin
  operations with different confirmation phrases.
- **Presentation hosting** at `/qbq`: the SOS deck as one self-contained
  document, with persistent inline edits (reading is public, **saving requires
  full admin**) and a phone remote paired by a short code. Pairing codes, session
  tokens, and presentation text are deliberately never logged.

---

## 5. Permissions and access rules

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
keys: `super_admin`, `trailer_manager`, `trailer_employee`,
`trailer_accounting`, `trailer_viewer`. Custom roles always get a `custom_`
prefixed key and may never claim a reserved key or `super_`/`admin_` prefix
(`services/rbac/roleKeys.js`).

- **`admin.full_access`** is the gate for the whole company-wide admin API. In
  `server/api.js` most routers are mounted behind
  `legacyAuthMiddleware = [authMiddleware, requirePermission('admin.full_access')]`.
- **Trailer routes are per-permission** (`trailers.view`, `trailer_rentals.create`,
  `trailer_payments.reverse`, `trailer_map.view`, …) via `requirePermission`.
- **Trailer Manager scoping** (`server/routes/adminUserScope.js`): an account with
  `trailer_users.manage` but **not** `users.manage` sees and edits only accounts
  whose roles are all `trailer_`-prefixed. Out-of-scope accounts return **404,
  never 403**, so their existence cannot be inferred.
- **The last active super administrator cannot be deactivated or demoted.**

### Non-JWT access paths (be careful changing these)

| Path | Gate |
|---|---|
| `/raise/*`, `/api/raise/:token/*` | Per-**round** token (expiring) + per-team OTP, used by dispatchers |
| `/recruiters`, `GET /api/recruiters/public-stats` | Public; names + KPI numbers only |
| `/questions`, `/answers`, `/api/sos/*` (non-admin) | Public; whitelisted content and anonymous **company-wide** aggregates only (no department or dispatch-team results) |
| `/qbq`, `/qbq/remote`, `GET /api/qbq/*` | Public read; **saving is full-admin**; rate-limited pairing |
| `/employee-birthday-form`, `POST /api/submit-employee-birthday` | Public form |
| `/facebook/connect/:sessionToken`, `/facebook/oauth/*` | Session token |
| `ALL /webhook`, `ALL /rc-webhook` | Raw-body proxied to the Python worker; signature verified there |
| `/api/internal/*` | `internalSharedSecretGuard` (`LEADS_INTERNAL_SHARED_SECRET`) |
| `/api/route-screenshot-media/:id`, `/api/trailer-media/:id` | Short-lived HMAC-signed URLs (Telegram has no session) |
| `POST /api/dat-ui/inspect` | Loopback only |
| `/`, `/health`, `/api/health`, Meta compliance pages (`/privacy-policy.html`, `/terms-of-use`, `/user-data-deletion`) | Public |
| `/presentation` | Public — the **owner-facing product deck** (`server/presentation/index.html`). A different document from the QBQ deck at `/qbq`; do not conflate them |

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
| Home-time Approve / Do Not Approve (`services/homeTimeRequestConstants.js` `isHomeTimeApprover`) | same shape: `HOME_TIME_APPROVER_USER_IDS` when set, otherwise `HOME_TIME_APPROVER_USERNAMES` with hardcoded defaults |

Both are deliberate: *"once immutable IDs are configured, usernames no longer
grant authority."* Configuring the IDs in the environment is what hardens them.
Do not copy the username fallback into new code, and do not describe either gate
as ID-only.

---

## 6. Important integrations

| Integration | Config source | Used by | Failure behavior |
|---|---|---|---|
| **Telegram** (Telegraf 4) | `BOT_TOKEN`, group IDs in `config/config.js`; IPv4 agent | everything | `safeSend` does 429-aware retries with backoff and rethrows permanent errors (403 / chat not found / deactivated / upgraded) immediately — it does **not** downgrade HTML to plain text; that fallback is feature-local (`dispatchEtaUpdateService.js`). 409 polling conflicts are suppressed, not fatal |
| **Datatruck** (the company TMS, read-only) | `DATATRUCK_API_TOKEN`, `DATATRUCK_COMPANY` | loads/ETA, mileage bonus, BOL/POD forwarding | features degrade to fallbacks (pinned message, chat history) or skip the tick |
| **Samsara + Drive HoS ELD** | admin **Settings** (`eld_settings`) takes precedence over env | `/location`, `/status`, ETA, live map, fuel alerts, Route Control, duplicate-unit check | GPS fallback chain **Samsara → Factor ELD → Leader ELD** with transient retries (`services/liveLocationResolver.js`) |
| **Google Maps** (Routes + Geocoding) | `GOOGLE_MAPS_API_KEY`, Settings → GMaps `enabled` | ETA routing, Route Control geometry, geocoding | off-route warnings stop; destination auto-completion keeps working |
| **Meta / Facebook** | `META_*`, `WEBHOOK_VERIFY_TOKEN`, `FACEBOOK_TOKEN_ENCRYPTION_KEY` | lead capture, Page connect | events are persisted before processing, then retried |
| **RingCentral** | `RC_*` env → shared pair in `ringcentral_settings`; **per-recruiter** creds live on the `recruiters` row (its own JWT always, optional custom client pair — `resolveRecruiterRcAuth`) | lead auto-SMS, two-way mirroring, recruiter call KPIs | SMS-only fallback when an MMS filter rejects; token refresh |
| **Bitrix24 CRM** | `BITRIX24_*` + field maps in `config/` | dual delivery of every Facebook lead | best-effort; never blocks the Telegram post |
| **AI: Groq and Gemini** | `GROQ_API_KEY`, `GEMINI_API_KEY` | reports, insights, annotation, group-status classification, driver-profile parsing, trailer vision/verification/extraction, fuel detection, home-time intent, translation | **the fallback is per-consumer, not global** — see below |
| **Supabase Storage** (optional) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TRAILER_STORAGE_BUCKET` | trailer media | **optional by design** — with no bucket, bytes go to Postgres (`trailer_media_blobs`); reads follow the backend recorded on the row |
| **Gmail App Password** | `GMAIL_USER`, `GMAIL_APP_PASSWORD` | raise OTP email | RingCentral SMS is the alternative channel |

**There is no single AI stack — check the provider before you touch a consumer.**
`services/groqClient.js` and `services/geminiClient.js` are independent clients,
and each feature picks its own:

- **Groq-first, Gemini fallback** inside the consumer (e.g.
  `translationService.js`, `aiAnnotationService.js` — they catch the Groq error
  and retry on Gemini only if `GEMINI_API_KEY` is set).
- **Two-way, order decided at runtime**: `server/services/dispatchParserService.js`
  tries **Gemini first** when the extracted text is weak or came from PDF OCR
  (`preferGeminiFirst`), otherwise Groq first — and falls back to a deterministic
  parser if both providers fail.
- **Groq only**: `aiAnalysisService.js`, `aiInsightsService.js`.
- **Gemini only**: trailer vision/semantic verification/master-list extraction,
  fuel-stop detection, the home-time services, `driverProfileAiParser.js`.

So an AI call is **not** automatically resilient — do not assume a fallback
exists, and do not delete a provider as "redundant". Consumers must degrade or
fail closed; the trailer monitor fails closed to review.

**AI prompt-injection fencing is a critical invariant.** Driver text is
untrusted and is fenced (`<driver_transcript>` plus sanitizers) before reaching
any model. See `tests/aiTranscriptFence.test.js`. Never remove the fencing.

**Every image sent to a model goes through `services/aiImagePrep.js`.** It
EXIF-rotates, bounds the long edge to 1600px, re-encodes JPEG and strips
metadata — turning a typical 12 MP phone photo from several megabytes into a
couple of hundred KB, which matters because base64 inflates the payload another
third on the way out of Render. The models downsample internally, so recognition
of VINs, trailer numbers and document text is unaffected (`tests/aiImagePrep.test.js`).
Two rules: it shrinks only the **transient copy sent outbound** — stored
originals stay untouched (`trailerImageService.processTrailerUpload` persists
them as evidence) — and it **fails open**, passing PDFs and undecodable buffers
straight through so a model never simply receives nothing. Callers:
`trailerVisionService`, `trailerImportService`, `trailerMasterList/extraction`,
`homeTimeImportService`, `dispatchPinnedContextService`,
`server/services/dispatchParserService`. Do not add a new `toString('base64')`
image path that bypasses it.

### Configuration model

Only **five** environment variables are required (`config/config.js`
`requiredEnv`): `DATABASE_URL`, `JWT_SECRET`, `BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`,
`FACEBOOK_TOKEN_ENCRYPTION_KEY`. **Most other settings carry a hardcoded default
in `config/config.js`** — a deliberate decision so only true secrets live in the
Render environment, and new non-secret config belongs there as a default rather
than as a new required variable.

**But "has a default" is not universal, and the exceptions are deliberate.** The
four bonus/review Telegram group IDs (`mileageBonusGroupId`, `roadBonusGroupId`,
`dispatchReviewGroupId`, `raiseResultsGroupId`) resolve to `''` on purpose:
*"deliberately NO hardcoded group-id default"*. When a category has neither a DB
value nor an env value, the message is **not sent** and a clear configuration
error is logged — never a silent send to a stale old group, and never a fallback
to another category's group. Do not "restore the missing default".

**Required-secret validation happens at the startup boundary**
(`assertRequiredConfig()`, called by `index.js` and the db scripts). The
invariant is that **importing `config/config.js` must never terminate the
process** — that is what lets tests import services with no production secrets
(`tests/configStartupBoundary.test.js`). Do not reintroduce an import-time
`process.exit`. One import-time `throw` does exist by design: with
`NODE_ENV=production` and neither `CORS_ALLOWED_ORIGINS` nor
`RENDER_EXTERNAL_URL` set, requiring the module throws.

Several integrations are **runtime-editable in the admin Settings tab and the DB
row wins over env**: `eld_settings`, `ringcentral_settings`, `gmaps_settings`,
`message_group_settings`, `trailer_settings`, `safety_event_video_settings`,
`bol_pod_forwarding_settings`.

---

## 7. Automatic and background behavior

There is **no cron library** — every job is a `setInterval` or self-rescheduling
timer started from `index.js` and stopped by the shared shutdown coordinator.
**They all send real messages to real people.**

Most of them poll on a **short, cheap tick and gate internally** on a
time-of-day or on due rows — so the tick cadence is not the business cadence.

**Jobs with a KNOWN next due time now sleep until it** instead of polling
(`services/dueTimeWakeTimer.js` for weekly jobs, `services/dailyWakeSchedule.js`
for once-a-day jobs, `services/jobQueueScheduler.js` for durable queues). Those
wakes land ON the due moment, so they are more punctual than the poll they
replaced, not less. Every sleep is **capped** (an hour) so a config change is
picked up without a restart, and a failed send always re-arms on a short retry
cadence. Queue workers additionally drain **on the producer's event**, so a
Facebook lead or a trailer payment receipt is delivered on the same tick it
arrives — the sweep is only a crash/lost-wake backstop. Guarded by
`tests/facebookWebhookImmediateProcessing.test.js` (a lead is still delivered
without any timer firing), `tests/jobQueueScheduler.test.js` and
`tests/backgroundWakeTimers.test.js`.

| Service | Tick | What it does |
|---|---|---|
| `schedulerService` | 60s + hourly retention | delivers due `scheduled_messages` |
| `dispatchEtaUpdateService` | 90s | per-group ETA updates, `FOR UPDATE SKIP LOCKED` claims |
| `birthdayService` (drivers) | sleeps to the next 08:00, re-checks hourly (was 60s) | wishes at an hour/timezone **hardcoded in the module** (08:00 America/Chicago) — there is no settings row or env var for it |
| `employeeBirthdayWishService` | sleeps to the configured send time, re-checks hourly (was 60s) | wishes at the `send_hour` / `send_minute` / `timezone` from `employee_birthday_settings` |
| `groupStatusAiService` | 60s | AI classification of group activity |
| `mileageBonusService` | sleeps to the next Wed 07:00, capped 1h (was 60s) | milestone detection → bonus notification |
| `raiseApprovalService` | sleeps to `next_run_at`, capped 1h; re-armed on a settings save (was 60s) | weekly raise round auto-send, `service_runs` dedupe |
| `fuelStopAlertService` | 150s | fuel-stop proximity replies |
| `homeTimeReminderService` | 5 min (first tick +30s) | the two clarification reminders |
| `roadBonusNotifierService` | 10 min (first tick +20s) | retry safety net for road-bonus summaries |
| `datatruckDocumentService` | `DATATRUCK_DOC_POLL_MINUTES` (15) | new BOL/POD → matching driver group, deduped |
| `duplicateUnitCheckService` | 15 min (first tick +90s) | duplicate-unit / name-mismatch reports |
| `routeControlService` (monitor) | settings-driven, floor 30s | destination completion + off-route warnings |
| `trailerNotificationService` | drains on enqueue; retry wakes on `available_at`; 15 min idle sweep (was a 15s poll) + 5 min reminder enqueue | trailer payment/overdue notifications; **only when the department flag is on** |
| `recruiterCallSyncService` | self-rescheduling `setTimeout` | RingCentral call-log sync |
| `facebookWebhookService` worker | drains on arrival; retry wakes on `next_retry_at`; 15 min idle sweep (was a 5s poll) | verified Meta webhook events with retry |
| `memoryWatchdog` | **off by default**; 15 min when on | heap/RSS pressure logging. Requires `MEMORY_WATCHDOG_ENABLED='true'`; `MEMORY_WATCHDOG_INTERVAL_MS` is clamped to ≥60s |
| Python leads child | supervised process | Meta + RingCentral webhook intake |

Event-driven (no timer) but equally live: the driver-group message pipeline
(`bot/handlers/groupCaptureHandlers.js`) fans a single incoming message out to
home-time detection, fuel-stop capture, trailer monitoring, auto-reactions,
pinned-context snapshots, and the recent-message buffer.

### Idempotency ledgers — do not weaken

Each of these stops a duplicate real-world action (a second message, a second
payment notification, a second bonus). **Never turn a successful send into a
retry.**

| Guard | Stops |
|---|---|
| `mileage_bonus_notifications` UNIQUE `(driver_normalized_name, threshold_miles)` | the same milestone being announced twice |
| `mileage_bonus_runs` (leased, unique `run_key`) | a weekly **run** overlapping or replaying itself |
| `service_runs` | a scheduled service firing twice for one due window |
| `facebook_webhook_events` (`leadgen:<pageId>:<leadgen_id>`) | a re-delivered Meta lead being posted twice |
| `facebook_lead_sms_mirrors` | an SMS reply being mirrored twice |
| `datatruck_document_deliveries` | the same BOL/POD being forwarded twice |
| `fuel_monitor_inbox` | one fuel-stop post creating several watches |
| `dispatch_eta_updates` / `fuel_stop_alerts` claim pattern (`FOR UPDATE SKIP LOCKED`) | two ticks working the same row |
| `driver_road_history.bonus_posted_at` (atomic claim) | a completed road leg being announced twice |
| home-time clarification claims (count + `next_reminder_at`) | a restart doubling a reminder |
| `responses` UNIQUE `(driver_id, question_id)` | a driver answering one question twice |
| `route_assignment_attachments` unique index | a second screenshot per assignment (replacement is a single UPSERT) |

`bot_sent_messages` belongs to this family but is **not** a guard — it is the
after-the-fact record of what was sent (§4).

---

## 8. Data model and cross-feature relationships

- **PostgreSQL, no ORM.** One `pg.Pool` in `database/pool.js` (`max=5`).
- **`database/db.js` is mostly a compatibility seam.** It re-exports **about 30**
  per-feature modules (`groups`, `driverProfiles`, `drivers`, `questions`,
  `broadcasts`, `facebookLeads`, `rbac`, most `trailer*`, …) so long-standing
  `require('../database/db')` callers keep working — if you move one of those
  exports, keep a re-export or you will break distant features. It also **still
  owns live code**: `initializeDatabase()` (the boot-time schema + migration
  entry point), the `admins` queries, the `service_runs` claim helpers and the
  group-directory queries.
- ⚠️ **The seam is NOT universal — several feature modules are required
  directly**, including `database/homeTime.js` and `database/routeControl.js`.
  `db.someHomeTimeFn(...)` is `undefined`. Check `database/db.js`'s require list
  before assuming a helper is reachable through it; new code should prefer
  requiring the feature module directly anyway.
- **Schema is applied automatically at boot**, in two layers:
  1. **Baseline** `database/schema.sql` — additive and idempotent, applied
     verbatim in one transaction on **every** boot. It is **GENERATED** from
     `database/baseline/*.sql` by `npm run build:schema`. **Do not hand-edit it**
     (CI checks it is in sync).
  2. **Forward migrations** `database/migrations/NNNN_*.sql` — run-once, tracked
     in the `schema_migrations` ledger. **All new schema changes go here**
     (`npm run migrate:new -- <name>`).
  Additive only: new columns must be nullable or defaulted, never `DROP`. A bad
  statement can crash-loop production. See `docs/database/migration-notes.md`.
- **~113 tables** (109 in the baseline + 4 from migrations).
- **`database/baseline/*.sql` plus `database/migrations/` is the real schema** —
  read those, not a snapshot. Committed generated snapshots
  (`schema-current.md`, `relationships.md`) used to live in `docs/database/` and
  drifted to 76 tables while the baseline grew past 100; they have been removed
  and are now gitignored. `npm run db:docs` still generates a reference on demand
  against a reachable database. See `docs/database/README.md`.

### `groups` is the hub of the data model

Every driver and staff Telegram group is a `groups` row: `telegram_group_id`,
`group_type` (`driver` / `employee` / other), `language` (en/ru/uz), `active`,
plus unit and driver parsed from the Telegram title (convention
`WENZE UNIT # <unit> <NAME> (COMPANY DRIVER)`, parsed by
`services/driverGroupTitle.js`). `driver_profiles` hangs off it one-to-one.
**Nearly every feature joins to `groups`** — surveys, broadcasts, dispatch, home
time, fuel, bonuses, Route Control, trailer monitoring.

**Cross-repo coupling:** the `samsara-integration` service also reads `groups`
(for driver-group routing) and reads the `safety_event_video_settings` /
`safety_event_music_assets` rows this repo's admin Settings tab manages, while
writing `safety_event_video_jobs`. **A `groups` schema change affects both
repos** — coordinate it.

### Other relationships worth knowing before you change something

- **Home time → road bonus → employee recognition.** A single road→home
  transition writes `driver_road_history`, may post a road-bonus summary to the
  bonus group, and posts a recognition-only (no dollar amounts) message to the
  employee group. Changing the state machine touches all three.
- **Live GPS is shared infrastructure, but there are TWO paths — a change to one
  does not fix the other.**
  - **Per-driver lookups go through `liveLocationResolver`** (Samsara → Factor →
    Leader, with transient retries): `/location`
    (`bot/handlers/dispatchCommandHandlers.js`), ETA updates and the `/status`
    snapshot (`dispatchEtaUpdateService.js`), fuel alerts, Route Control
    (`routeControl/assignmentLocation.js`), and dispatch test diagnostics.
  - **Batch/fleet fetches do NOT use it.** The Live Locations map
    (`liveLocationsService.js`) calls `samsaraLocationService` / `driveHosEldService`
    directly and re-implements the same provider order, and the duplicate-unit
    check uses Samsara only. So fixing the fallback chain in the resolver leaves
    the map unchanged — check both when you touch provider behavior.
- **Trailer master list is the single authority for trailer identity.** The map,
  default lists, agreements and the rental picker all filter on official status.
- **Optimistic locking**: trailers, agreements, items, companies and invoices
  carry a `version` column; a stale version gets HTTP 409, never a silent
  overwrite.
- **Audit redaction** (`database/trailerAudit.js` `redact`) recursively strips
  passwords, hashes, tokens, secrets and signed-URL material at any depth.

---

## 9. Decisions and behavior that must be preserved

The full per-feature invariants, with the tests that guard each one, live in
`docs/architecture/route-control.md` and
`docs/architecture/trailer-invariants.md`; `CLAUDE.md` links to them and holds
the repository-wide working rules. The highest-consequence items:

1. **Signed-URL media transport.** Route Control screenshots and trailer media
   reach Telegram as short-lived HMAC-signed HTTPS URLs
   (`/api/route-screenshot-media/:id`, `/api/trailer-media/:id`) — never as raw
   `Buffer`/multipart uploads from Render. The direct-upload path repeatedly
   stalled in production. Signed URLs and query strings are never logged.
   Existing text-only messages are converted **in place** with
   `editMessageMedia`, never replaced with a new post.
   BOL/POD forwarding follows the same rule for the same reason plus bandwidth:
   `datatruckDocumentService` passes the Datatruck URL to `Input.fromURL(url)`,
   which in Telegraf 4.x is *literally* `url.toString()` — a plain string form
   field, so **Telegram's servers** fetch the file and the bytes never enter this
   process. `Input.fromURLStream(url, filename)` is the near-identical-looking
   trap: it returns `{url, filename}`, which makes Telegraf fetch the file itself
   and pipe it through Render. Never swap it in. The download-and-upload fallback
   (over Telegram's ~20MB URL limit, expired presigned links, URLs needing the
   Datatruck token) must stay — delivery reliability wins there.
   Guarded by `tests/bolPodDirectFetch.test.js`.
2. **No code path may create a trailer from a detection.** A trailer joins the
   master list only through an approved import or permission-gated manual
   creation. `ensureTrailerForDetection` resolves only and returns null for an
   unknown unit; the caller queues a `trailer_unmatched_mentions` review row.
   Enforcement lives in the data-access layer, and a static test fails if a new
   `INSERT INTO trailers` site appears. The legacy screenshot importer is
   **disabled on purpose** — do not re-enable a second import authority.
3. **Trailer uploads must work with no Supabase configured** — requiring it was a
   production outage: uploads 503'd, so the required pickup photo never stored, so
   pickup activation failed.
4. **Archive and merge never delete**, and a trailer with an open rental can be
   neither archived nor merged. A merge reassigns history to the survivor and
   keeps both identifiers resolving as aliases.
5. **The legacy trailer backfill is idempotent and production-critical** — it
   re-runs on every boot and must stay a strict no-op (guarded by
   `legacy_rental_id`), and the old `trailer_rentals` table plus `/rentals/*`
   endpoints must keep working.
6. **Grace period is applied once, at reminder time.** `due_at` is the payment
   deadline only — never bake grace into it.
7. **Every booking path calls `assertTrailerAvailable`** — it is the only gate
   that sees both rental systems at once (§4).
8. **AI transcript fencing** stays (§6).
9. **IPv4 Telegram agent** stays (§2).
10. **The webhook raw-body proxy must stay mounted before `express.json()`** or
    Meta signature verification breaks.
11. **Auth hardening stays**: HS256 pin, login rate limit, shared-secret guards,
    the loopback guard on `/api/dat-ui/inspect`, 404-not-403 for out-of-scope
    accounts, and the last-super-admin protection.
12. **Handler order in `bot/bot.js` is behavior.** Feature-specific
    `bot.action(...)` handlers must stay registered before the survey/broadcast
    `callback_query` catch-all, which must remain last. Middleware `next()`
    chains are load-bearing.
13. **Config validation stays at the startup boundary**, not at import time.
14. **Do not re-add the Samsara poller to this process** (§2).

### Code-structure rules (enforced by CI)

- **500-line hard maximum** for hand-written `.js/.jsx/.mjs/.cjs/.ts/.tsx` under
  `bot`, `database`, `scripts`, `server`, `services`, `tests`, `admin/src`.
  `npm run lint:filesize` enforces it; `scripts/fileSizeBaseline.json` records
  legacy violations and **may only ever shrink**. Do not add entries to it.
- Prefer a **re-export-only façade plus focused modules** when an import path must
  be preserved. `services/routeControlService.js` → `services/routeControl/*` is
  the reference example: 18 lines, pure re-export, nothing of its own.
  (`database/db.js` is a *partial* version of the same idea — it re-exports, but
  it also still owns live code: `initializeDatabase()`, the `admins` queries, the
  `service_runs` claim helpers and the group-directory queries. Do not treat it as
  re-export-only.)
- Dependencies flow one way: routes → service façade → focused services →
  database/integrations → pure helpers. **No circular dependencies.** No business
  logic in route files.
- Keep pure decision logic separate from I/O so it can be unit-tested without a
  database or network — this is why so many services export pure evaluators.

---

## 10. Known limitations, retired features and intentional exceptions

- **FleetView is archived, not present.** No `fleet/`, no `server/fleet/`, no
  `/update` SPA, no `/api/v1/*`. It is preserved at the git tag
  `archive/fleetview-disabled`, its tables were deliberately **not** dropped, and
  **CI actively fails if it reappears** in the runtime. Treat any FleetView
  mention in older docs as historical. See `docs/ARCHIVED_FEATURES.md`.
- **Retired features whose data was kept**: the driver location check-in /
  "Checked In / Checked Out" monitor (`driver_location_monitors`,
  `driver_location_checkins`), employee voting polls (`employee_votes*`), and the
  "Ask the Data" / "Chat Monitor" admin panels. See
  `docs/architecture/retired-*.md`.
- **`bot/locationCheckinHandlers.js` is a deliberate stub, not dead code.** The
  poller that sent check-in prompts is gone, so no new prompts exist — but the
  handler stays registered so a driver tapping an **old** button on an old message
  gets a "feature has been retired" alert instead of silence. Do not delete it
  while those messages still exist in Telegram history.
- **Two authorities for trailers by history**: the legacy `trailer_rentals` table
  and `/rentals/*` endpoints coexist with the newer agreements/items model on
  purpose (§9.5). Do not "clean this up" without a migration plan.
- **The legacy trailer screenshot importer is intentionally disabled**, not
  broken (§9.2).
- **The two documents previously flagged as stale here have been resolved**: the
  drifted generated schema snapshots were removed (§8), and the "create a
  Supabase bucket before enabling uploads" instruction in
  `docs/trailer-department.md` was corrected to describe the database-storage
  fallback (§9.3). No document is currently known to contradict the code — but
  that is a statement about what has been checked, not a guarantee. If you find
  one that disagrees with the code, **the code wins** and the document gets
  fixed in the same task.
- **No frontend type checking or lint.** The admin SPA is plain JS + Vite; a
  successful `npm run build --prefix admin` plus its component tests is the
  validation.
- **Admin navigation is state-based**, not URL-router-based, except for the
  special-cased public paths (`/dispatch`, `/raise`, `/recruiters`, `/questions`,
  `/answers`, `/trailers`) which `App.jsx` reads from `window.location`. Pages
  are lazy-loaded behind a chunk-error boundary.
- **Committed artifacts, not runtime logic**: the `SOS Prezentatsiya … .html`
  deck (**used** — `server/qbq/template.js` serves it at `/qbq`),
  `eng.traineddata` (Tesseract OCR data), `birthdays.csv` (read by
  `scripts/import-birthdays.js`), and a Russian-language book text file that
  nothing references. The old committed log snapshots (`app.log`, `admin.log`)
  and the `scratch/`, `brain/`, `reports/` and `.cursor/` working directories
  have been removed and gitignored — nothing in the application read them.
- `package.json` declares `engines.node` twice (`>=20`, then `>=18.0.0` — the
  later wins). CI and Render both use Node 20.

---

## 11. Testing and operational expectations

```bash
node --test --test-concurrency=1 tests/*.test.js   # Node suite (bash glob)
npm test                                          # Node suite + Python leads tests
npm run build --prefix admin                      # admin production build
npm test --prefix admin                           # admin component tests
npm run lint:filesize                             # 500-line limit
npm run build:schema:check                        # schema.sql is in sync with baseline/
```

- **The Node suite passes clean with no secrets and no database.** Verified
  baseline (2026-09-01, deps installed, no `TEST_DATABASE_URL`): **2145 tests,
  2007 pass, 0 fail, 138 skipped** (the skips are the `*Pg` integration tests),
  exit 0. With a database (`TEST_DATABASE_URL`) the `*Pg` suites run instead of
  skipping: **209 tests, 209 pass, 0 skipped.** The Python leads worker adds
  **17 tests** (`python -m unittest discover -s leads-bot -p "test_*.py"`). **So any failure is a real
  failure** — there is no "expected failures" allowance. *(An older internal doc
  claimed ~19 expected failures in a bare environment; that is no longer true and
  must not be used to excuse one.)* If
  you see mass failures, check `npm install` has run — a bare clone dies at
  `require('dotenv')`.
- **`*Pg.test.js` need `TEST_DATABASE_URL` and skip without it. A skipped test is
  not a passing test.** The harness creates a throwaway **database** per test
  (not a schema — `schema.sql` guards look up constraints by name with no schema
  filter) and applies the real, complete `schema.sql`. The database must be
  **UTF8** (`TEMPLATE template0`) because `schema.sql` contains box-drawing
  characters in comments.
- **CI** (`.github/workflows/ci.yml`) runs three jobs: static checks + admin
  build, the Node unit suite with **no application env at all**, and the
  PostgreSQL integration suite against a real Postgres 16 service container.
  **Both test jobs fail on ANY skip.** CI also asserts FleetView stays archived.
- **Run the suite before claiming success, and report the exact command and
  pass/fail counts.** Never claim a test passed that you did not run.
- **Prefer test endpoints over real sends** when validating manually:
  `POST /api/broadcast/test` (management group only),
  `POST /api/questions/send-test`, the dispatch test hub
  (`DISPATCH_ETA_TEST_GROUP_ID`), the trailer Automatic-Updating (Test) group,
  and the isolated SOS test mode.
- **Never point a local process at production tokens or the production
  database.** `node index.js` with production env polls the production bot and
  sends real messages to real drivers.
- **Never print, log or commit a secret value.** Read-only secret scanning:
  `gitleaks dir . --redact` — report file and line only, never the value.

---

## 12. Where to look next

| Need | Go to |
|---|---|
| Config, defaults, feature flags | `config/config.js` — read this first |
| Process orchestration, job startup, shutdown | `index.js` |
| HTTP mounting order and route inventory | `server/api.js` |
| Auth and permission middleware | `server/middleware/auth.js` |
| A feature's HTTP surface | `server/routes/<feature>Routes.js` |
| Business logic | `services/` — one concern per file, packages for large features |
| Queries | `database/<feature>.js` (`db.js` is only the re-export seam) |
| Schema (authoritative) | `database/baseline/*.sql` (source) → `database/schema.sql` (generated); new work in `database/migrations/` |
| Admin UI | `admin/src/App.jsx`, `admin/src/pages/`, `admin/src/api/` |
| Telegram handlers and send helpers | `bot/bot.js` (order!), `bot/handlers/`, `bot/senders.js` |
| How to work in this repo (rules, safety, testing) | `CLAUDE.md` |
| The implementation workflow | `.claude/skills/implement/SKILL.md` (`/implement`) |
| Route Control + media-transport invariants | `docs/architecture/route-control.md` |
| Trailer master list / storage / agreements invariants | `docs/architecture/trailer-invariants.md` |
| Database: authoritative schema + migration rules | `database/baseline/`, `database/migrations/`, `docs/database/` |
| What was removed and why | `docs/ARCHIVED_FEATURES.md`, `docs/architecture/retired-*.md`, `docs/architecture/samsara-separation.md` |
| Trailer Department operations | `docs/trailer-department.md` |
| Deployment checks | `docs/deployment/pre-deploy-checklist.md`, `render.yaml` |

### Working conventions

CommonJS, one concern per service file, `console.*` with a structured prefix
(`[API]`, `[BOT]`, `[DB]`, `[SCHEDULER]`, `[TRAILER]`, …), additive SQL only, and
a test in `tests/` for whatever you changed. Match the surrounding code.
**When in doubt about production impact, stop and ask rather than guessing** —
and if a behavior is genuinely ambiguous, say so instead of inventing it.
