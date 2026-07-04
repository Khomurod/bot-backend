# App pre-prompt — the whole picture

Paste this whole file at the start of a new AI coding session, then add your task
in a sentence or two. It gives the AI the complete picture of the system — every
major part, not just one — plus a map of where each thing lives so it can go
straight to the right file and work cleanly.

---

## What this is

**Wenze** is an operations platform for a US trucking company, built around
Telegram. It started as a driver-feedback bot and grew into an all-in-one back
office: driver communication and broadcasts, dispatch/ETA and live truck
tracking, fuel monitoring, driver HR (home time, raises, mileage bonuses,
birthdays), recruiting KPIs, Facebook/Meta lead capture with auto-SMS, and a
full fleet/TMS dashboard — all administered from web panels and wired to a dozen
outside services. It is a **real production system** running on Render.

Almost every feature ultimately does one of two things: **send/receive Telegram
messages to driver groups**, or **read/write the shared PostgreSQL database**.
When in doubt, follow those two threads.

## Deployment topology (what runs where)

Two Render services + one external repo, all sharing **one PostgreSQL database**:

1. **`driver-feedback-bot`** (this repo, Node) — the core. A single process
   (`index.js`) runs: the main Telegram bot (Telegraf, long-polling), the
   Express HTTP API + admin/fleet web apps, ~12 background schedulers, and it
   **spawns the Python leads bot as a child process**.
2. **`facebook-leads-engine`** (this repo, `leads-bot/`, Python/FastAPI) — the
   WenzeLeadBots worker, run as the child above. Facebook lead verification and
   RingCentral SMS webhooks.
3. **`samsara-integration`** (separate repo, Node) — polls the Samsara API for
   safety events and pushes dashcam alerts to Telegram. Talks to this app only
   through the shared DB and shared bot tokens.

The instance is **memory-constrained** (small heap) — avoid heavy in-process
work and watch for leaks. Outbound Telegram traffic is **pinned to IPv4**
(`services/telegramAgent.js`) because the host's IPv6 path to Telegram
black-holes file uploads.

## The three Telegram bots

- **`@wenzefeedback_bot`** — main bot, token `BOT_TOKEN`. Driver feedback,
  broadcasts, dispatch/ETA commands, the creator control panel. (`bot/bot.js`)
- **`@wenzeleadbot` (WenzeLeadBots)** — leads bot, token `TELEGRAM_BOT_TOKEN`.
  Facebook leads, auto-SMS, RingCentral replies. (`leads-bot/`, plus
  `services/leadsTelegramClient.js` for Node-side sends)
- **`@wenzesambot`** — Samsara safety alerts, token `SAMSARA_BOT_TOKEN`, in the
  separate `samsara-integration` repo.

(`@datatruck_driver_bot` is a third-party bot ours only reacts to — not ours.)

## Feature domains (the whole surface)

Each domain usually spans an **admin page** (`admin/src/pages/…`) + **API route**
(`server/routes/…` or `server/api.js`) + **service(s)** (`services/…`) +
**queries** (`database/db.js`), and sometimes a **bot handler** (`bot/…`) and a
**scheduler**.

- **Driver feedback & questions** — multilingual questions to driver groups,
  answers forwarded to management in English. `QuestionsPage`, `bot/bot.js`,
  `services/translationService`.
- **Broadcasts & scheduled messages** — one-off/recurring announcements to
  chosen audiences (all / by language / active / employee / company groups),
  with media. `BroadcastPage`, `ScheduledMessagesPage`,
  `services/broadcastTargetService`, `services/schedulerService`,
  `services/broadcastTemplateService`. Creator can also broadcast from Telegram
  (`bot/creatorBroadcastHandlers.js`).
- **Bot message manager** — edit/delete messages the bot already sent; forward a
  bot message to manage it. `MessageManagerPage`, `BotMessagesPage`,
  `bot/creatorMessageManager.js`, `services/botSentMessageRegistry`.
- **Dispatch / ETA** — `/location`, `/status`, `/load`, `/update` in driver
  groups; automatic ETA updates. `DispatchPage`, `services/dispatchEtaUpdateService`,
  `etaRoutingService`, `dispatchPinnedContextService`, `currentLoadService`,
  `bot/dispatchStatusLookupHandlers.js`.
- **Live locations** — live truck map for admins, resolved from ELD/GPS.
  `LiveLocationsPage`, `services/liveLocationsService`, `liveLocationResolver`,
  `samsaraLocationService`, `driveHosEldService` (Factor/Leader ELD), `geocoder`.
- **Fuel monitor** — fuel-stop alerts along routes. `FuelMonitorPage`,
  `services/fuelStopAlertService`.
- **Driver HR** — **home time** requests/imports (`HomeTimePage`,
  `homeTimeRequestService`, `homeTimeImportService`), **raises** (75¢/mile
  approval flow + public page, `RaiseApprovalPage`/`RaisePublicPage`,
  `raiseApprovalService`, `otpService`), **mileage/road bonuses**
  (`MileageBonusPage`, `mileageBonusService`, `roadBonusNotifierService`),
  **birthdays** (`CompanyBirthdaysPage`, `birthdayService`,
  `employeeBirthdayWishService`).
- **Groups & access** — group directory, membership, admin-grant deep links.
  `GroupsPage`, `GroupAccessPage`, `services/groupAccessService`,
  `driverGroupDirectoryService`, `driverProfileParse` (group names encode
  unit #, driver, language, company-driver flag).
- **Recruiter KPIs** — RingCentral call-log sync, admin dashboard, and a public
  gamified daily leaderboard at `/recruiters`. `RecruiterKpiPage`,
  `RecruitersPublicPage`, `recruiterCallSyncService`, `ringCentralCallService`.
- **Facebook/Meta leads** — self-serve Page connect, webhook lead capture →
  formatted Telegram post → auto-SMS → Bitrix24 CRM. `FacebookLeadsPage`,
  `LeadsPage`, `services/facebookWebhookService`, `facebookConnectService`,
  `facebookGraphService`, `facebookLeadAutoMessageService`,
  `facebookLeadSmsMirrorService`, `ringCentralSmsService`, `bitrix24Service`,
  `indeedLeadService`. (The Python `leads-bot/` handles verification + RC webhooks.)
- **AI features** — auto-translation, driver/company insight reports, chat
  annotations, AI group-status classification, AI driver-profile parsing.
  `AiFeaturesPage`, `services/aiAnalysisService`, `aiInsightsService`,
  `aiAnnotationService`, `groupStatusAiService`, `driverProfileAiParser`.
  Model clients: `groqClient`, `geminiClient`, plus OpenAI (`translationService`).
- **Datatruck (TMS) integration** — pulls loads/mileage and forwards BOL/POD
  docs to driver groups; peer-bot banter. `services/datatruckLoadService`,
  `datatruckDocumentService`, `datatruckApiService`, `bot/datatruckPeerHandlers.js`.
- **FleetView** — a **separate React TMS app** served at **`/update`**
  (`fleet/`): loads board, dispatch board/map, drivers, brokers, companies,
  equipment, fuel/tolls, statistics. Its API is under `/api/v1`
  (`server/fleet/`).
- **Anonymous feedback** — private-chat flow relaying complaints to a group with
  no identifying info. `bot/anonymousFeedbackHandlers.js`.

## Outside integrations

Telegram (Telegraf) · PostgreSQL · OpenAI / Groq / Gemini (AI) · Meta/Facebook
Graph (leads) · RingCentral (SMS + call logs) · Bitrix24 (CRM) · Samsara +
Drive HoS / Factor ELD / Leader ELD (telematics) · Datatruck (TMS) · Google
Maps/Routes/Geocoding · Gmail (OTP email) · Indeed (leads).

## Tech stack

- **Node.js ≥18, CommonJS** (`require`, not ESM). Express, Telegraf 4.15, `pg`,
  Luxon (Central Time), `multer`, `tesseract.js` (OCR), `pdf-parse`,
  `nodemailer`, `openai`.
- **Two React (Vite) frontends** built to static files and served by Express:
  `admin/` (24 pages) and `fleet/` ("FleetView", `/update`).
- **Python** (`leads-bot/`, FastAPI/uvicorn) for the leads worker.
- Auth: JWT + bcrypt for the admin panel.

## Repository map

| Path | What lives there |
|---|---|
| `index.js` | Process bootstrap: bot + API + schedulers + leads child, graceful shutdown, crash circuit-breaker. |
| `config/config.js` | **Central config** — validates required secrets, hardcodes all non-secret defaults (group ids, feature flags, base URLs). Read this first to see every knob. |
| `bot/bot.js` + `bot/*.js` | Telegram handlers (the main file is the hub; siblings are focused flows). |
| `services/` | **~84 modules — most business logic lives here**, one concern per file. Usually where a feature actually is. |
| `server/api.js` + `server/routes/` | Express API: JWT auth, `/api/*` routes, media upload, static serving. |
| `server/fleet/` | FleetView's `/api/v1` backend. |
| `database/db.js` + `database/schema.sql` | **All SQL** (~3500 lines; every query is a function) and the schema (auto-migrated on boot). |
| `admin/src/pages/`, `admin/src/api.js`, `admin/src/components/Shared.jsx` | Admin panel React. |
| `fleet/src/` | FleetView React app. |
| `leads-bot/` | Python leads worker. |
| `tests/` | **94 `node --test` files** (+ Python tests), named after the module they cover. |
| `scripts/` | One-off ops scripts (seed admin, init db, migrations, backfills, env checks). |
| `docs/` | Design notes; `docs/architecture/module-map.md` is a deeper module map. |

## Conventions

- **Data model** hangs off the `groups` table: `group_type` (`driver` default /
  `employee` / other), a `language` (`en`/`ru`/`uz`) and `active` flag on driver
  groups. Targeting flows through `services/broadcastTargetService.js`.
- **Config over env**: only true secrets are required env vars (`DATABASE_URL`,
  `JWT_SECRET`, `BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`,
  `FACEBOOK_TOKEN_ENCRYPTION_KEY`); everything else has a default in
  `config/config.js`. Prefer adding a default there over a new required env var.
- **Telegram**: all clients are IPv4-pinned (`services/telegramAgent.js`). Use
  `copyMessage` to deliver content in its exact original format.
- **Creator-only** features are gated by numeric Telegram user id
  `CREATOR_USER_ID = 2117922421` (`bot/creatorMessageManager.js`), never username.
- **Tests**: `npm test` = `node --test tests/*.test.js` + Python tests. Tests stub
  Telegram/DB — most need no network/DB. A handful fail only for missing live
  env/DB; those are pre-existing.
- **Git**: feature branch → commit → PR → squash-merge to `main`; Render
  auto-deploys `main`. Keep changes minimal and matched to surrounding style.

## How to give a task after this primer

State the symptom or feature and, if you know it, the surface (which admin/fleet
page, bot command, or lead flow). Expect the AI to: locate the relevant
`services/` or `bot/` module and its `database/db.js` queries, make a minimal
change, add/adjust a `tests/` test, run `npm test`, and — for anything
user-facing — verify against real behavior before committing.
