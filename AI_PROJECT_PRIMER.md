# AI PROJECT PRIMER — Wenze Trucking Operations & Driver Communication Platform

> **Read this document in full before making any change.** It was produced by a
> deep inspection of the actual code (all file paths and behaviors below were
> verified against the repository). It exists so future AI agents can understand
> the system quickly and modify it safely. Where something could not be fully
> verified it is explicitly marked **needs confirmation**.

---

## 1. App Summary

This is a **trucking operations and driver communication platform** for Wenze
Investments, a US trucking company. Its backend is a **Node.js/Express service**
that runs, in a single process:

- a **Telegram feedback/operations bot** (Telegraf, long-polling),
- the **HTTP API server** + two built React web apps,
- **~13 background scheduled jobs**,
- **Facebook/Meta lead processing** (with a spawned Python child process),
- **dispatch ETA automation**, **mileage bonus workflows**, **driver raise
  approval**, **home-time tracking**, **fuel monitoring**, **Datatruck document
  forwarding**, **recruiter call sync**, and other operations services.

Its business purpose: help the company **manage driver Telegram groups, collect
multilingual driver feedback, broadcast announcements, track dispatch/load
status and live truck locations, process recruiting leads, monitor operational
workflows, and coordinate driver-related tasks** — from web dashboards and from
Telegram itself.

Nearly every feature ultimately does one of two things: **send/receive Telegram
messages to driver groups** or **read/write the shared PostgreSQL database**.
Follow those two threads and you will find the feature.

### The three Telegram bots

| Bot | Token env var | Role | Where |
|---|---|---|---|
| `@wenzefeedback_bot` ("Wenze Support Bot") | `BOT_TOKEN` | Main bot: feedback, broadcasts, dispatch commands, creator panel | `bot/bot.js` (this repo, Node) |
| `@wenzeleadbot` (WenzeLeadBots) | `TELEGRAM_BOT_TOKEN` | Facebook leads, auto-SMS, RingCentral replies | `leads-bot/` (Python child) + `services/leadsTelegramClient.js` |
| `@wenzesambot` | `SAMSARA_BOT_TOKEN` | Samsara safety-event dashcam alerts | **Separate repo** `Khomurod/samsara-integration` |

The two polling tokens in this repo **must be distinct** — enforced at boot by
`assertDistinctTelegramPollingTokens()` in `index.js`. `@datatruck_driver_bot`
is a **third-party** bot ours only reacts to (`bot/datatruckPeerHandlers.js`).

### Deployment topology

Defined in `render.yaml` — Render hosts:
- **`driver-feedback-bot`** (Node web service) — this whole app (`index.js`).
- **`facebook-leads-engine`** (Python web service) — the leads bot can also run
  standalone; in the main deployment `index.js` spawns it as a **child process**
  (`startLeadsBot()`), supervised with exponential-backoff restart and a
  **circuit breaker** (5 crashes in 3 min → stop restarting; exit code 78 =
  permanent config error).
- The Samsara poller deploys from its own repo; it cooperates **only** through
  the shared Postgres `groups` table and Telegram tokens (it was removed from
  this process on purpose — it caused OOM kills; see
  `SAMSARA-SEPARATION-GUIDE.md`). **Do not re-add it.**

All three share **one PostgreSQL database**. The Node process runs with
`--max-old-space-size=256` (memory-constrained instance — avoid heavy
in-process work). All Telegram traffic is **pinned to IPv4** via
`services/telegramAgent.js` because the host's IPv6 path to `api.telegram.org`
black-holes file uploads (small requests pass, multi-packet upload bodies
stall). Do not remove that agent.

---

## 2. Main User-Facing Areas

### Admin panel (React + Vite, `admin/`)

Served at **`/admin`** from the static build `admin/build/` (built by the root
`postinstall`). Navigation is **state-based, not URL-router-based**: a
`pages` map in `admin/src/App.jsx` switches on a page key. Pages
(`admin/src/pages/`):

Dispatch Center (`DispatchPage`), Live Locations (`LiveLocationsPage`),
Facebook Leads (`FacebookLeadsPage`), Customer Inquiries/Leads (`LeadsPage`),
Send Message/Broadcast (`BroadcastPage`), Surveys/Questions (`QuestionsPage`),
Driver Groups (`GroupsPage`), Birthdays (`CompanyBirthdaysPage`),
Mileage Bonuses (`MileageBonusPage`), Driver Raises (`RaiseApprovalPage`),
Home Time (`HomeTimePage`), Fuel Monitor (`FuelMonitorPage`),
Users (`UsersPage`), Bot Group Access (`GroupAccessPage`),
Message Manager (`MessageManagerPage`), Bot Messages (`BotMessagesPage`),
Scheduled Messages (`ScheduledMessagesPage`), Settings (`SettingsPage`),
Recruiter KPIs (`RecruiterKpiPage`), AI Features (`AiFeaturesPage`).

The API client is **`admin/src/api.js`** (single flat module of fetch wrappers;
JWT stored in `localStorage` under `token`). Shared widgets — including the
media uploader with client-side photo compression — live in
`admin/src/components/Shared.jsx`.

### Public / semi-public routes (no JWT)

These are reachable without login — **be careful changing them**:

- **`/raise/*`** → `RaisePublicPage.jsx` — driver raise submission page.
  Access is **per-driver token based**: `GET /api/raise/:token`, plus
  OTP verify (`/api/raise/:token/request-otp`, `/verify-otp`, `/submit`) in
  `server/routes/raiseRoutes.js` (`publicRouter`).
- **`/recruiters`** → `RecruitersPublicPage.jsx` — public gamified call
  leaderboard, backed by `GET /api/recruiters/public-stats` (names + KPI
  numbers only; no phone numbers). Main KPI: 2h30m real call duration/day
  (calls under 30s don't count); secondary: 150 outbound/day. Supports
  `?date=` (one day) and `?start=&end=` (range, max 31 days).
- **`/employee-birthday-form`** + `POST /api/submit-employee-birthday` —
  public birthday collection form.
- **`/`, `/health`, `/api/health`** — health/status. `/privacy-policy.html`,
  `/terms-of-use`, `/user-data-deletion` — Meta app compliance pages.
- **Facebook connect flow**: `/facebook/connect/:sessionToken`,
  `/facebook/oauth/start`, `/facebook/oauth/callback`,
  `POST /facebook/connect/:sessionToken/select-pages` — session-token gated.
- **Webhooks**: `ALL /webhook` (Meta) and `ALL /rc-webhook` (RingCentral) are
  **raw-body proxied** to the Python leads bot (`proxyToLeadsBot` in
  `server/api.js`, mounted **before** `express.json` to preserve
  `X-Hub-Signature-256` for signature verification).
- `POST /api/dat-ui/inspect` — loopback-only (rejects non-localhost).
- `/api/internal/*` routes — guarded by `internalSharedSecretGuard`
  (`LEADS_INTERNAL_SHARED_SECRET`), used by the Python child and the Gmail
  Indeed Apps Script (`POST /api/internal/indeed/lead`).

Everything else under `/api/*` requires the admin JWT (see §9).

---

## 3. Fleet Operations Platform ("FleetView", `/update`)

A **self-contained TMS-style module**, deliberately isolated from the rest:

- **Frontend**: separate React/Vite app in **`fleet/`** (built to
  `fleet/build/`, served at `/update` with SPA fallback). Pages
  (`fleet/src/pages/`): Dashboard, LoadsPage (+LoadDrawer), DispatchBoard,
  DispatchMap, UpdateBoard, DriversPage, BrokersPage, CompaniesPage,
  EquipmentPage, FuelTolls, RateSavings, Statistics, TasksPage, EmailsPage,
  UsersPage, SettingsPage, HelpPage, LoginPage, SupportPage. State via a
  custom store (`fleet/src/store.jsx`), API client `fleet/src/api.js`.
- **Backend**: **`server/fleet/`** — mounted by `server/fleet/index.js`
  (`mountFleet(app)`), the **only** integration point with the host app. API at
  **`/api/v1/*`** (`server/fleet/router.js`, ~73 endpoints). Failure to mount
  is caught in `server/api.js` so the main app keeps running without it.
- **Data modes** (`server/fleet/config.js`, `FLEETVIEW_DATA_MODE`):
  - `real` (production default): reads the **existing** integrations — Postgres
    (`realDb.js`), Datatruck (`dataTruckAdapter.js`), etc. via
    `realProvider.js`. Single hardcoded tenant "Wenze".
  - demo: in-memory store (`store.js`) with demo data.
- **Auth** (`server/fleet/auth.js`): JWT; in real mode it **federates with the
  main admin panel's `JWT_SECRET`** and fails closed if unset. Tenant is derived
  from the verified token, never the request body. Permissions enforced
  server-side.

---

## 4. Backend Architecture

### Entry point — `index.js`

Boot order: `assertDistinctTelegramPollingTokens()` → `db.initializeDatabase()`
(runs `schema.sql`) → wire Telegram instances into ETA/Facebook services →
`startServer()` (Express) → `await startBot()` (Telegraf long-polling) → start
~12 schedulers → `startLeadsBot()` (spawn Python child). Graceful shutdown on
SIGINT/SIGTERM/uncaught errors: stop all services → stop bot/server → SIGTERM
then SIGKILL the child → drain the DB pool (5s timeout) → exit.
`unhandledRejection` specially **suppresses Telegram 409 polling conflicts**
(two pollers on one token) instead of crashing.

### Express app — `server/api.js` (~3,100 lines)

Order matters in this file:
1. CORS (`config.corsAllowedOrigins`; production **requires** explicit origins
   or `RENDER_EXTERNAL_URL`).
2. **Raw webhook proxies** (`/webhook`, `/rc-webhook`) and the internal Indeed
   route — mounted **before** `express.json()` (signature preservation).
3. `express.json({ limit: '1mb' })`, static `/admin`.
4. FleetView mount (`require('./fleet').mountFleet(app)`, try/caught).
5. Auth (`/api/auth/login` with per-IP rate limiting, `/api/auth/verify`).
6. Feature routes — inline in `api.js` (auth, groups, driver profiles,
   questions, broadcasts, scheduled messages, mileage bonus, AI reports/insights,
   employee birthdays, media upload) plus mounted routers from
   `server/routes/`:

| Mount | Router file | Notes |
|---|---|---|
| `/api/dispatch` | `dispatchRoutes.js` | authMiddleware at mount |
| `/api/facebook-leads` | `facebookLeadsRoutes.js` | takes `{ authMiddleware }` |
| `/api/raise/admin` | `raiseRoutes.js` `adminRouter` | own `adminAuth` inside; mounted before public |
| `/api/raise` | `raiseRoutes.js` `publicRouter` | **public, token+OTP** |
| `/api/home-time` | `homeTimeRoutes.js` | |
| `/api/fuel-monitor` | `fuelMonitorRoutes.js` | receives `bot.telegram` |
| `/api/live-locations` | `liveLocationsRoutes.js` | |
| `/api/bot-users` | `botUsersRoutes.js` | |
| `/api/settings` | `settingsRoutes.js` | ELD/RingCentral creds |
| `/api/recruiters` | `recruiterRoutes.js` | has public `GET /public-stats` |
| `/api/bot-messages` | `botMessagesRoutes.js` | receives `bot.telegram` |
| `/api/groups` (members) | `groupMembersRoutes.js` | |
| `/api/v1` | `server/fleet/router.js` | FleetView |

7. SPA fallbacks: `/admin/*`, `/dispatch/*`, `/raise/*`, `/recruiters/*` all
   serve the admin build's `index.html`.

**Media upload** (`POST /api/upload-media`): multer memory storage (20MB cap;
photos rejected over Telegram's 10MB `sendPhoto` limit **before** upload), then
staged to `MEDIA_STORAGE_CHAT_ID` via a **dedicated raw `Telegram` client**
(`stagingTelegram`) with AbortController timeouts (40s × 2 attempts),
supergroup-migration retry (`migrate_to_chat_id`), and actionable error
mapping. The staged message is deleted after the `file_id` is captured.

### Services layer — `services/` (~84 modules)

**Most business logic lives here**, one concern per file. See §7/§8 for the
per-domain breakdown, and `docs/architecture/module-map.md` for a deeper map
(note: that doc has a few stale references, e.g. a removed "location monitor"
feature — trust the code over the doc).

### Scheduled jobs (all started from `index.js`; all can send REAL messages)

| Service | What it does |
|---|---|
| `schedulerService.js` | Polls `scheduled_messages` every 60s and delivers due broadcasts; hourly retention tick. Anti-drift, self-rescheduling. |
| `dispatchEtaUpdateService.js` | Periodic per-group ETA updates (claims rows in `dispatch_eta_updates` with `FOR UPDATE SKIP LOCKED`). |
| `birthdayService.js` / `employeeBirthdayWishService.js` | Driver/employee birthday wishes to groups. |
| `groupStatusAiService.js` | AI classification of group activity/status. |
| `mileageBonusService.js` | Mileage milestone detection → bonus notifications (`mileage_bonus_runs` dedupe). |
| `datatruckDocumentService.js` | Polls Datatruck for new BOL/POD docs → forwards to the matching driver group (idempotent via `datatruck_document_deliveries`). |
| `raiseApprovalService.js` | Weekly raise round auto-send (`service_runs` dedupe). |
| `fuelStopAlertService.js` | Fuel-stop proximity alerts (`fuel_stop_alerts` claims). |
| `recruiterCallSyncService.js` | Background RingCentral call-log sync into `ringcentral_calls`. |
| `roadBonusNotifierService.js` | Road-bonus notifications. |
| `facebookWebhookService.js` worker | Queue+retry processing of verified Meta webhook events. |

There is **no cron library** — everything is `setInterval`/self-rescheduling
timers inside these services.

### Error handling & logging

`console.*` with structured prefixes (`[DB]`, `[API]`, `[BOT]`, `[LEADS]`,
`[SCHEDULER]`, `[SHUTDOWN]`, `[CREATOR-PANEL]`, …). Global
`uncaughtException`/`unhandledRejection` → graceful shutdown (except Telegram
409). Log files `app.log` / `admin.log` exist in the repo root (committed
snapshots; not live logs).

---

## 5. Frontend Architecture

Two separate React 18 + Vite apps, both plain-JS (no TypeScript), both built to
static `build/` folders and served by Express:

- **`admin/`** — state-switch navigation in `App.jsx` (no react-router URL
  routes except the special-cased public paths `/raise`, `/recruiters`,
  `/dispatch` which `App.jsx` detects from `window.location`). All server calls
  go through `admin/src/api.js` (fetch + `Authorization: Bearer <token>` from
  localStorage; `API_BASE = '/api'`). Shared UI in
  `admin/src/components/Shared.jsx` (buttons, modals, `MediaUploader` with
  client-side photo downscaling to ≤2560px JPEG — Telegram recompresses photos
  anyway, so this is lossless in practice). Styling is inline styles + a CSS
  file; state is React `useState`/`useEffect` — **no Redux/query library**.
- **`fleet/`** — richer SPA with its own shell (`Shell.jsx`), store
  (`store.jsx`), API client (`api.js`), components (`components.jsx`), pages in
  `fleet/src/pages/`. Base path `/update/`.

Duplicated logic to be aware of: each app has its **own** API client and auth
handling; they only share the backend.

---

## 6. Database / Data Layer

- **PostgreSQL**, accessed via a single `pg.Pool` in `database/db.js`
  (`max=5`, `connectionTimeoutMillis=30000`, SSL auto-detected for
  supabase/neon/`sslmode=require`). The pool is deliberately small for the
  memory-constrained instance.
- **Schema**: `database/schema.sql` — **auto-run on every boot** by
  `initializeDatabase()` (everything `IF NOT EXISTS` / additive `ALTER`).
  **There is no migrations framework** — schema changes are made by editing
  `schema.sql` additively. Never add destructive `DROP`/`ALTER … DROP`; new
  columns must be nullable or defaulted.
- **Queries**: `database/db.js` (~3,600 lines — every query is a named
  function) plus per-feature helpers: `database/botUsers.js`,
  `mileageBonus.js`, `raiseApproval.js`, `homeTime.js`, `eldSettings.js`,
  `datatruckDocuments.js`, `ringcentral.js`. No ORM.
- **64 tables.** The most important, by domain:

| Domain | Tables (source of truth) |
|---|---|
| **Groups & drivers** | `groups` (**the hub of the data model** — every driver group, with `group_type` `driver`/`employee`/other, `language` en/ru/uz, `active`, unit/driver parsed from the title), `driver_profiles`, `drivers`, `group_members`, `bot_users` |
| Feedback/surveys | `questions`, `question_translations`, `question_media`, `options`, `option_translations`, `responses` (unique per driver+question) |
| Broadcasts | `broadcasts`, `broadcast_deliveries`, `broadcast_button_clicks`, `scheduled_messages` |
| Bot message ledger | `bot_sent_messages` (every send/edit/copy recorded), `group_pinned_messages`, `chat_logs` |
| Facebook leads | `facebook_connect_sessions`, `facebook_page_connections`, `facebook_webhook_events` (idempotency key `leadgen:<pageId>:<leadgen_id>`), `facebook_seen_senders`, `facebook_lead_auto_message_settings/_rules`, `facebook_lead_sms_mirrors`, `leads` |
| Dispatch/ETA | `dispatch_eta_updates`, `dispatch_eta_global_settings`, `group_recent_loads` |
| AI | `ai_reports`, `ai_insights`, `chat_message_annotations`, `sender_role_consensus` |
| Mileage bonus | `mileage_bonus_progress`, `mileage_bonus_notifications`, `mileage_bonus_runs` |
| Raises | `raise_settings`, `raise_rounds`, `raise_round_submissions`, `raise_round_picks`, `raise_otp`, `dispatch_teams`, `dispatch_team_drivers` |
| Home time | `home_time_settings`, `driver_home_status`, `driver_road_history`, `home_time_requests` |
| Fuel | `fuel_stop_alerts`, `fuel_monitor_inbox` |
| Recruiters | `recruiters`, `ringcentral_calls`, `ringcentral_settings` |
| Settings/admin | `admins`, `bot_access_settings`, `eld_settings`, `employee_birthdays`, `employee_birthday_settings`, `service_runs` |
| **Retired (data kept, no code)** | `employee_votes_polls/_options/_votes`, `driver_location_monitors`, `driver_location_checkins` (the check-in feature was retired; see `docs/architecture/retired-*.md`) |

**Cross-repo coupling:** the Samsara repo reads/writes `groups` too — a
`groups` schema change affects **both repos**.

---

## 7. Integrations

For each: config location → main files → data flow → dependents → failure mode.

### Telegram (Telegraf 4.15)
- **Config**: `BOT_TOKEN` / `TELEGRAM_BOT_TOKEN` (required), group IDs in
  `config/config.js`. IPv4 agent: `services/telegramAgent.js` (**all** clients).
- **Files**: `bot/bot.js` (main bot + all group handlers),
  `bot/creatorBroadcastHandlers.js` (creator-only panel),
  `bot/creatorMessageManager.js` (creator edit/delete via forward; owns
  `CREATOR_USER_ID = 2117922421`), `bot/anonymousFeedbackHandlers.js`,
  `bot/dispatchStatusLookupHandlers.js`, `bot/homeTimeRequestHandlers.js`,
  `bot/mileageBonusHandlers.js`, `bot/locationCheckinHandlers.js`,
  `bot/datatruckPeerHandlers.js`; helpers `services/telegramHtml.js`
  (`safeSend` with HTML-fallback + permanent-error detection),
  `telegramMention.js`, `telegramUrl.js`, `recentMessageBuffer.js`.
- **Sent-message ledger**: `services/botSentMessageRegistry.js` monkey-patches
  `telegram.callApi` to record every send into `bot_sent_messages` (powers the
  Message Manager and prevents duplicate-send bugs). **Never turn a successful
  send into a retry.**
- **Failure handling**: safeSend retries, permanent-error classification,
  polling-conflict suppression. Handler **order matters** in `bot/bot.js`.

### Facebook / Meta leads
- **Config**: `META_APP_ID`, `META_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`,
  `META_LOGIN_CONFIG_ID`, `FACEBOOK_TOKEN_ENCRYPTION_KEY` (required),
  `config/metaAppCredentials.json` fallback.
- **Flow**: Meta → `POST /webhook` (Node, raw proxy) → Python
  `leads-bot/webhook_server.py` verifies `X-Hub-Signature-256` → posts verified
  events back to Node `/api/internal/facebook/webhook-events` (shared secret) →
  `services/facebookWebhookService.js` queues, dedupes
  (`facebook_webhook_events`), fetches lead via Graph
  (`facebookGraphService.js`), formats (`facebookLeadFormatter.js`), posts to
  the leads Telegram group (WenzeLeadBots token), fires auto-SMS
  (`facebookLeadAutoMessageService.js` → `ringCentralSmsService.js`), mirrors
  SMS replies two-way (`facebookLeadSmsMirrorService.js`), and creates a
  Bitrix24 CRM lead (`bitrix24Service.js` + field maps in `config/`).
- **Self-serve Page connect**: `/connect` in a leads group →
  `facebookConnectService.js` OAuth pages (public routes above). Page tokens
  encrypted with `facebookCrypto.js`.
- **Also**: Indeed leads via Gmail Apps Script
  (`docs/gmail-indeed-apps-script.gs` → `/api/internal/indeed/lead` →
  `services/indeedLeadService.js`).
- **Failure handling**: webhook events persisted first, then processed with
  retry; `/retry/:id` and `/leads-log` proxy to the Python worker.

### Datatruck (the company's TMS)
- **Config**: `DATATRUCK_API_TOKEN`, `DATATRUCK_COMPANY` (subdomain, default
  `wenze`), doc-delivery knobs in `config/config.js`.
- **Files**: `services/datatruckApiService.js` (read-only OpenAPI client),
  `datatruckLoadService.js` (active loads → dispatch/ETA/FleetView),
  `datatruckDocumentService.js` (+`datatruckDocumentHelpers.js`) BOL/POD
  forwarding, `server/fleet/dataTruckAdapter.js` (FleetView),
  `mileageBonusService.js` (mileage source).
- **Depends on it**: dispatch `/load`, ETA context, mileage bonuses, FleetView
  loads, document forwarding. Failure → features degrade to fallbacks (pinned
  messages, chat history parsing) or skip the tick.

### Samsara / ELD / live locations
- **Config**: `SAMSARA_API_KEY(S)`; Drive HoS platform (`DRIVEHOS_API_BASE`,
  `FACTOR_ELD_COMPANY_KEY`, `LEADER_ELD_COMPANY_KEY`) — runtime-editable in
  admin **Settings** (`eld_settings` table) which takes precedence over env.
- **Files**: `services/liveLocationResolver.js` — **the GPS fallback chain**
  (Samsara → Factor ELD → Leader ELD) with `withTransientRetries`;
  `samsaraLocationService.js`, `driveHosEldService.js`,
  `liveLocationsService.js` (admin map), `geocoder.js`,
  `etaRoutingService.js` (Google Routes/Geocoding APIs).
- **Depends on it**: `/location`, `/status`, ETA updates, Live Locations page,
  fuel-stop alerts. The **safety-event** side lives in the separate repo.

### RingCentral
- **Config**: `RC_CLIENT_ID`, `RC_CLIENT_SECRET`, `RC_JWT_TOKEN`, `RC_FROM_NUMBER`;
  per-number recruiter creds runtime-editable in Settings (`ringcentral_settings`).
- **Files**: `services/ringCentralSmsService.js` (lead auto-SMS),
  `ringCentralCallService.js` + `recruiterCallSyncService.js` (call-log sync →
  KPIs), Python `leads-bot/sms.py` (inbound SMS webhook subscription).
- **Failure**: SMS-only fallback when MMS filter is rejected; token refresh.

### Bitrix24 CRM
- `BITRIX24_*` env vars; `services/bitrix24Service.js`, `bitrix24LeadMapper.js`,
  field maps `config/bitrix24LeadFieldMap*.json`. Dual-delivery of every
  Facebook lead (Telegram + CRM). Best-effort — CRM failure never blocks the
  Telegram post.

### AI providers
- **Groq** (`GROQ_API_KEY`, `services/groqClient.js`, primary) with **Gemini**
  cross-provider fallback (`GEMINI_API_KEY`, `geminiClient.js`) — the single
  integrated AI stack; broadcast auto-translation (`translationService.js`)
  runs on it too. `OPENROUTER_API_KEY` also present. Consumers: weekly AI reports
  (`aiAnalysisService.js`), insights (`aiInsightsService.js` +
  `insightRenderer.js`), message annotation (`aiAnnotationService.js`), group
  status classification (`groupStatusAiService.js`), driver-profile parsing
  (`driverProfileAiParser.js`), Datatruck banter.
- **CRITICAL INVARIANT**: driver text is untrusted. It is **fenced**
  (`<driver_transcript>` + sanitizers) before reaching any model — see
  `aiAnalysisService.js` / `aiAnnotationService.js` and
  `tests/aiTranscriptFence.test.js`. Never remove the fencing.

### Google Maps / Gmail
- `GOOGLE_MAPS_API_KEY` + Routes/Geocoding bases → `etaRoutingService.js`,
  `geocoder.js`. Gmail App Password (`GMAIL_USER`/`GMAIL_APP_PASSWORD`) →
  `services/otpService.js` (raise OTP email; RingCentral SMS alternative).

---

## 8. Core Workflows (step-by-step)

- **Driver feedback**: admin creates a question (`QuestionsPage` →
  `/api/questions`, translations via `translationService`) → sent to driver
  groups by language → drivers answer via inline buttons/text → `responses`
  (deduped) → forwarded to the management group in English → visible in admin.
- **Broadcasts**: `BroadcastPage` → `POST /api/broadcast/send` → targeting via
  `services/broadcastTargetService.js` (`target_type`: `all` /
  `language_groups` / `specific_drivers` / `company_drivers` / `employee` /
  `other_company`; `target_active_filter`) → `sendBroadcastToGroups` in
  `bot/bot.js` (media via staged `file_id`s, placeholders via
  `broadcastTemplateService.js`) → per-group `broadcast_deliveries`.
- **Scheduled messages**: `POST /api/scheduled-messages` (one-time or weekly,
  Central Time, Luxon) → `schedulerService.js` claims due rows → same broadcast
  path. Cancel/send-now endpoints exist.
- **Creator panel (Telegram-side messaging)**: private chat, **only** user id
  `2117922421` → `/panel` (or `/start`, `/broadcast`) → “Send Broadcast
  Message” (7 audiences) or “Send Single Message” (search a group by name) →
  any message is delivered **verbatim** via `copyMessage`
  (`bot/creatorBroadcastHandlers.js`).
- **Group lifecycle**: bot added to a Telegram group → `upsertGroup` parses the
  title (`services/driverGroupTitle.js` — `WENZE UNIT # <unit> <NAME>
  (COMPANY DRIVER)` convention) → driver profile auto-created/AI-synced →
  admin can flip language/active/birthday. Bot removed → deactivate.
- **Dispatch/ETA**: `/location`, `/status`, `/load`, `/update` in a driver
  group → resolve GPS (fallback chain) + current load (Datatruck → pinned →
  chat history) → reply with pin/summary; the scheduler pushes periodic ETA
  updates per enabled group. Test hub via `DISPATCH_ETA_TEST_GROUP_ID`.
- **Facebook lead**: see §7 — capture → verify → dedupe → Telegram post +
  auto-SMS + Bitrix24 + two-way SMS mirroring.
- **Mileage bonus**: `mileageBonusService.js` pulls miles (Datatruck) →
  milestone crossed → notification to `MILEAGE_BONUS_GROUP_CHAT_ID` with
  accounting-only Paid/Rejected buttons (`bot/mileageBonusHandlers.js`,
  gated by `MILEAGE_BONUS_ACCOUNTING_USER_IDS`) → tracked in
  `mileage_bonus_*` tables. **This is payroll-adjacent — change carefully.**
- **Driver raise (75¢/mile)**: weekly rounds (`raiseApprovalService.js`) →
  dispatch teams submit picks → per-driver tokenized public page (+OTP via
  Gmail/RC) → admin closes round (`/api/raise/admin/*`).
- **Home time**: driver group requests (`bot/homeTimeRequestHandlers.js`,
  approver mentions via `HOME_TIME_APPROVER_*`) → `home_time_requests`;
  road-history import (`homeTimeImportService.js`); admin `HomeTimePage`.
- **Fuel monitoring**: fuel-stop messages land in `fuel_monitor_inbox`
  (deduped) → `fuelStopAlertService.js` computes proximity/next-check →
  alerts to groups; admin `FuelMonitorPage`.
- **Recruiter KPIs**: `recruiterCallSyncService.js` syncs RingCentral call
  logs per recruiter → admin dashboard + public `/recruiters` leaderboard.
- **Datatruck documents**: poll delivered orders for new BOL/POD uploads →
  match order → driver group by driver name → send document (≤45MB), dedupe
  by unique signature.

---

## 9. Authentication & Permissions

- **Admin JWT**: `POST /api/auth/login` — bcrypt against the `admins` table
  (seeded by `scripts/seed-admin.js` from `ADMIN_USERNAME`/`ADMIN_PASSWORD`),
  per-IP login rate limiting, HS256 token (24h). `authMiddleware`
  (`server/api.js`) **pins `algorithms: ['HS256']`** (blocks alg-none/asym
  forgeries). Frontend stores the token in localStorage.
- **No role system** in the admin panel — any admin token grants all admin
  APIs. FleetView has its own role/permission resolution (`server/fleet/auth.js`)
  but in real mode federates the same `JWT_SECRET`.
- **Internal calls**: `internalSharedSecretGuard`
  (`LEADS_INTERNAL_SHARED_SECRET`) for Python-child ↔ Node and Indeed ingest.
- **Public token flows**: raise page (per-driver token + OTP), Facebook connect
  (session token).
- **Telegram-side authorization**: creator features check **numeric user id**
  (`CREATOR_USER_ID` in `bot/creatorMessageManager.js`); mileage-bonus buttons
  check accounting user ids; home-time approvals check approver ids. Never
  authorize by username.
- **Security-sensitive files**: `server/api.js` (authMiddleware, CORS, proxy),
  `server/fleet/auth.js`, `services/facebookCrypto.js`,
  `config/config.js`, `bot/creatorMessageManager.js`.

---

## 10. Important Files and Directories

- `index.js` — process orchestrator (see §4). **Do not weaken the circuit
  breaker or shutdown ordering.**
- `config/config.js` — central config: validates the 5 required secrets, holds
  every default (group ids, feature flags, API bases). **Read this first.**
- `config/telegramBotTokens.js`, `config/metaAppCredentials.json`,
  `config/bitrix24LeadFieldMap*.json` — token/credential/field-map helpers.
- `bot/bot.js` — main Telegraf wiring: group message pipeline, driver
  registration, broadcast send helpers (`sendBroadcastToGroups`,
  `sendQuestionToGroups`), dispatch commands, `/start`. **Handler order
  matters.**
- `bot/*.js` — focused handlers (creator panel, creator message manager,
  anonymous feedback, dispatch lookup, home time, mileage bonus, datatruck
  peer, location check-ins [retired feature's handler still present]).
- `services/` — ~84 business-logic modules (see §7/§8 for ownership).
- `server/api.js` — Express app (see §4).
- `server/routes/` — 11 feature routers.
- `server/fleet/` — FleetView backend (see §3).
- `server/services/dispatchParserService.js` — dispatch parsing helpers used by
  routes.
- `database/db.js` — the shared query surface (~3,600 lines). Split-in-place
  guidance exists in `docs/architecture/module-map.md`.
- `database/schema.sql` — auto-applied schema; additive-only.
- `database/*.js` — per-feature query helpers.
- `admin/` — admin SPA (see §2/§5); `admin/src/api.js` is the API client.
- `fleet/` — FleetView SPA (see §3).
- `leads-bot/` — Python FastAPI worker: `webhook_server.py` (endpoints
  `/webhook`, `/rc-webhook`, `/health`, `/retry/{id}`, `/leads-log`),
  `graph.py` (Meta Graph), `sms.py` (RingCentral), `config.py`, `main.py`.
- `tests/` — ~95 Node test files (`node:test`), named after the module they
  cover, plus Python tests in `leads-bot/`.
- `scripts/` — ops one-offs: `seed-admin.js`, `init-db.js`,
  `import-birthdays.js`, `backfill-driver-profiles.js`, `migrate-media.js`,
  `check-prod-env.js`, `discover-bitrix-lead-fields.js`, etc.
- `docs/` — `architecture/module-map.md` (deep map; slightly stale in spots),
  `architecture/live-locations.md`, retired-feature notes,
  `deployment/pre-deploy-checklist.md` (follow it before shipping),
  `gmail-indeed-apps-script.gs`.
- `render.yaml` — Render deployment (2 services). `setup.sh` — local setup.
- `utils/` — small helpers (e.g. `birthdaySort.js`).
- `eng.traineddata` — Tesseract OCR language data (used by `tesseract.js`).
- `app.log` / `admin.log`, `scratch/`, `brain/`, `reports/` — committed
  artifacts/scratch; not runtime-critical.

---

## 11. Configuration and Environment Variables

**Required (process exits without them)** — `config/config.js` `requiredEnv`:
`DATABASE_URL`, `JWT_SECRET`, `BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`,
`FACEBOOK_TOKEN_ENCRYPTION_KEY`.

**Everything else is optional with hardcoded defaults** in `config/config.js`
(deliberate design: only true secrets live in Render env). Key groups (see
`.env.example` for the full annotated list):

- **Telegram/groups**: `MANAGEMENT_GROUP_ID`, `MEDIA_STORAGE_CHAT_ID`,
  `EMPLOYEE_GROUP_ID`, `TELEGRAM_CHAT_ID` (leads group),
  `DISPATCH_ETA_TEST_GROUP_ID`, `ANONYMOUS_FEEDBACK_GROUP_ID`.
- **Meta/leads**: `META_APP_ID`, `META_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`,
  `META_LOGIN_CONFIG_ID`, `META_REQUESTED_PERMISSIONS`,
  `LEADS_INTERNAL_SHARED_SECRET`, `LEADS_BOT_PORT`, `ENABLE_LEADS_BOT`.
- **Bitrix24**: `BITRIX24_ENABLED`, `BITRIX24_WEBHOOK_URL`, `BITRIX24_ENTITY`,
  assorted mapping vars.
- **Telematics**: `SAMSARA_API_KEY(S)`, `DRIVEHOS_API_BASE`,
  `DRIVEHOS_PROVIDER_KEY`, `FACTOR_ELD_COMPANY_KEY`, `LEADER_ELD_COMPANY_KEY`
  (admin Settings/`eld_settings` overrides env at runtime).
- **RingCentral**: `RC_CLIENT_ID`, `RC_CLIENT_SECRET`, `RC_JWT_TOKEN`,
  `RC_FROM_NUMBER`, `RC_API_BASE` (runtime override via
  `ringcentral_settings`).
- **Datatruck**: `DATATRUCK_API_TOKEN`, `DATATRUCK_COMPANY`, doc-delivery
  knobs (`DATATRUCK_DOC_*`).
- **AI**: `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`.
- **Maps/Email**: `GOOGLE_MAPS_API_KEY`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`.
- **Workflow gates**: `MILEAGE_BONUS_GROUP_CHAT_ID`,
  `MILEAGE_BONUS_ACCOUNTING_USER_IDS`, `HOME_TIME_APPROVER_USER_IDS`.
- **Platform**: `PORT` (Render injects), `RENDER_EXTERNAL_URL`,
  `CORS_ALLOWED_ORIGINS` (**required in production** unless
  `RENDER_EXTERNAL_URL` set), `NODE_ENV`, `PG_POOL_MAX`,
  `FLEETVIEW_DATA_MODE`, `ADMIN_USERNAME`/`ADMIN_PASSWORD` (seeding only).

**Local development minimum**: the 5 required secrets + a Postgres. Tests need
none (they stub env/DB). Never print or commit secret values.

---

## 12. Known Risks / Caution Areas for Future AI Agents

1. **This is production.** The bot talks to real drivers; schedulers send real
   messages on their own timers. Running `node index.js` locally **with
   production env vars will poll the production bot token and send real
   messages** — don't.
2. **Telegram polling tokens**: `BOT_TOKEN` ≠ `TELEGRAM_BOT_TOKEN` ≠ Samsara's
   token. Two pollers on one token = 409 conflict loop.
3. **Handler order in `bot/bot.js`** — specific `bot.action(...)` handlers must
   stay registered before generic handlers; middleware `next()` chains are load-
   bearing (creator panel, anonymous feedback, home-time all pass through).
4. **Idempotency ledgers** (do not weaken): `bot_sent_messages`,
   `facebook_webhook_events`, `facebook_lead_sms_mirrors`,
   `datatruck_document_deliveries`, `service_runs`, `fuel_monitor_inbox`,
   `responses` unique constraint, `dispatch_eta_updates`/`fuel_stop_alerts`
   claim pattern, `mileage_bonus_runs`.
5. **AI prompt-injection fencing** in `aiAnalysisService.js` /
   `aiAnnotationService.js` — never remove.
6. **`schema.sql` is auto-applied at boot** — additive changes only; a bad
   statement can crash-loop production. Coordinate `groups` changes with the
   Samsara repo.
7. **Payroll-adjacent code**: mileage bonuses (`mileageBonusService.js`) and
   raises (`raiseApprovalService.js`) affect real money. Test with stubs;
   never trigger real runs.
8. **Public routes** (§2) and CORS: don't loosen `authMiddleware`, the HS256
   pin, the login rate limit, or the loopback guard on `/api/dat-ui/inspect`.
9. **Webhook raw-body proxy** must stay mounted **before** `express.json` or
   Meta signature verification in the Python worker breaks.
10. **Memory**: 256MB heap, pool max 5. Avoid buffering large files, unbounded
    caches, or new always-on intervals.
11. **IPv4 pinning** (`services/telegramAgent.js`) — removing it re-breaks
    media uploads in production.
12. **`database/db.js`** is imported everywhere; renaming/moving exported
    functions breaks distant features. Re-export if you must move.
13. **`MEDIA_STORAGE_CHAT_ID` / group ids**: Telegram groups that upgrade to
    supergroups get new `-100…` ids; code has migration retries but env values
    may need updating.
14. **Docs can be stale** (e.g. module-map references a removed
    location-monitor feature). **Trust the code.**

---

## 13. Testing and Validation

- **Run everything**: `npm test` → `node --test --test-concurrency=1
  tests/*.test.js && python -m unittest discover -s leads-bot -p "test_*.py"`.
- **Node tests only**: `node --test --test-concurrency=1 tests/*.test.js`
  (~95 files, ~500 tests). Tests stub Telegram/DB — no network needed.
  **Known baseline**: ~19 tests fail in a bare environment because they expect
  live env/DB (e.g. `aiAnnotation`, `facebookCrypto`, `translationParser`,
  `databaseModuleSurface` — the latter exits on missing env). **Before
  changing code, run the suite once to capture the baseline, and after your
  change confirm you added zero new failures.**
- **Single file**: `node --test tests/<name>.test.js`.
- **Frontends**: `cd admin && npm run build` and `cd fleet && npm run build`
  (Vite; build success is the validation — there is **no lint/typecheck setup**
  and no frontend unit tests).
- **Boot smoke test** (no network sends): load modules with stub env —
  `DATABASE_URL=postgres://test JWT_SECRET=x BOT_TOKEN=1:A
  TELEGRAM_BOT_TOKEN=2:B FACEBOOK_TOKEN_ENCRYPTION_KEY=k node -e
  "require('./server/api'); console.log('ok')"`.
- **Manual workflow validation**: prefer test endpoints —
  `POST /api/broadcast/test` (sends only to the management group),
  `POST /api/questions/send-test`, the dispatch test hub
  (`DISPATCH_ETA_TEST_GROUP_ID`) — over real sends.
- **Never** run destructive commands, trigger real scheduled jobs, or point a
  local process at production tokens/DB.

---

## 14. Instructions for Future AI Agents

1. **Read this primer first**, then `config/config.js`, then the specific
   files for your task. `docs/architecture/module-map.md` has a deeper map
   (verify against code — parts are stale).
2. **Inspect before you modify.** Find the owning service in `services/`, its
   queries in `database/db.js` (or `database/<feature>.js`), its route in
   `server/api.js`/`server/routes/`, and its UI page. Do not guess business
   logic — read it, and if it is still ambiguous, say “needs confirmation”
   rather than inventing behavior.
3. **Preserve integrations.** Telegram, Datatruck, Samsara/ELD chain,
   Facebook/Meta leads, RingCentral, Bitrix24, dispatch/ETA, mileage bonuses,
   raises, home time, and live locations are all production-live. Do not
   change their contracts, tokens, webhooks, or idempotency ledgers casually.
4. **Be careful with anything that sends messages.** Schedulers and broadcast
   paths reach real drivers. Use the test endpoints and the management group;
   never fire real sends to driver groups while developing.
5. **Run tests and builds before finalizing**: full Node suite (compare to the
   pre-change baseline; zero new failures), plus `admin`/`fleet` builds if you
   touched a frontend. Verify user-facing changes against real behavior where
   safely possible.
6. **Keep changes small, modular, and in-style**: CommonJS, one concern per
   service file, `console` prefix logging, additive SQL only, match the
   surrounding code’s conventions. Add or update a test in `tests/` for what
   you changed.
7. **Explain your changes clearly**: list changed files and why; commit on a
   feature branch → PR → squash-merge to `main` (Render auto-deploys `main`).
8. **Never hardcode credentials, tokens, chat ids of real people, or secrets;
   never log or commit secret values.** New non-secret config belongs as a
   default in `config/config.js`, not a new required env var.
9. **Do not** re-add the Samsara poller to this repo, remove the IPv4 agent,
   weaken auth (HS256 pin, rate limit, shared-secret guards), reorder
   `bot/bot.js` handlers, or drop/alter existing DB columns.
10. **When in doubt about production impact — stop and ask** the user instead
    of proceeding.
