# About this app — AI session primer

Paste this at the start of a new AI coding session so the assistant understands
the codebase before you give it a task. Keep the task itself short after this —
this primer tells the AI *where* to look.

## What it is

A **Telegram-bot backend for a trucking company (Wenze)**. It collects driver
feedback, sends broadcasts and announcements, tracks dispatch/ETA and live truck
locations, captures Facebook/Meta leads, runs recruiter-call KPIs, and more —
all managed from a React web admin panel. It is a real production system running
on Render.

## The three Telegram bots

1. **`@wenzefeedback_bot`** — the main bot ("Wenze Support Bot"), token `BOT_TOKEN`.
   Driver feedback, broadcasts, dispatch/ETA commands, the creator control panel.
   Instantiated in `bot/bot.js` (Telegraf).
2. **`@wenzeleadbot` (WenzeLeadBots)** — leads bot, token `TELEGRAM_BOT_TOKEN`.
   Facebook lead capture, auto-SMS, RingCentral. Runs as a **Python child process**
   (`leads-bot/main.py`, FastAPI/uvicorn) spawned by `index.js`.
3. **`@wenzesambot`** — Samsara safety-event alerts, token `SAMSARA_BOT_TOKEN`.
   Lives in a **separate repo** (`samsara-integration`), shares the same DB.

(`@datatruck_driver_bot` is an external third-party bot the main bot merely
reacts to — not ours.)

## Stack & how it's built

- **Node.js ≥18**, CommonJS (`require`, not ESM). Entry point: **`index.js`** —
  one process that starts the Telegraf bot (long-polling), the Express API, ~12
  background schedulers, and spawns the Python leads child.
- **Telegraf 4.15** for Telegram. **Express** for the HTTP API + serving the
  admin build. **PostgreSQL** via `pg`. **Luxon** for time (Central Time).
  **OpenAI** for translation/AI. `multer` uploads, `tesseract.js` OCR,
  `pdf-parse`, `nodemailer`.
- **Two React (Vite) frontends**: `admin/` (the admin panel, 24 pages) and
  `fleet/` ("FleetView", mounted at `/update`). Both are built to static files
  and served by Express.
- **Deploy**: single Render web service (`render.yaml`). The instance is
  memory-constrained (small heap) — be mindful of memory and of long-running
  work in-process. Outbound Telegram traffic is **pinned to IPv4**
  (`services/telegramAgent.js`) because the host's IPv6 path to Telegram
  black-holes file uploads.

## Repository map — where to find things

| Path | What lives there |
|---|---|
| `index.js` | Process bootstrap: starts bot, API, schedulers, leads child, graceful shutdown. |
| `config/config.js` | **Central config.** Validates required secrets, hardcodes non-secret defaults (group ids, feature flags). Start here to see every env var and default. |
| `bot/bot.js` | Main Telegraf bot: command/message handlers, broadcast send helpers. Large file; the hub of bot behavior. |
| `bot/*.js` | Focused bot handler modules (creator panel, anonymous feedback, dispatch status lookup, datatruck peer, mileage bonus, home-time, etc.). |
| `services/` | **~84 modules — the business logic.** One concern per file (broadcast targeting, ETA routing, live-location resolver, Facebook webhook, RingCentral, Datatruck, translation, etc.). This is usually where a feature actually lives. |
| `server/api.js` | Express app: auth (JWT), all `/api/*` routes, media upload, static serving. |
| `server/routes/` | Route modules mounted by `api.js` (dispatch, leads, settings, recruiter, raises, live-locations, …). |
| `database/db.js` | **All SQL** (~3500 lines) — every query is a function here. `database/schema.sql` is the schema (tables auto-created/migrated on boot). |
| `admin/src/pages/` | Admin panel React pages (one per feature: BroadcastPage, GroupsPage, DispatchPage, SettingsPage, …). `admin/src/api.js` is the API client; `admin/src/components/Shared.jsx` has shared widgets (incl. media upload). |
| `fleet/` | The separate "FleetView" React app served at `/update`. |
| `leads-bot/` | The Python leads bot (FastAPI). |
| `tests/` | **94 `node --test` files** (+ Python tests). Named after the module they cover. |
| `docs/` | Design notes and this primer. |

## Core conventions

- **Data model**: everything hangs off the `groups` table. `group_type` is
  `driver` (default), `employee`, or other. Driver groups carry a language
  (`en`/`ru`/`uz`) and an `active` flag. Broadcast/scheduler targeting all flows
  through `services/broadcastTargetService.js` → `database/db.js`.
- **Config over env**: only true secrets are required env vars; non-secret
  config (group ids, feature flags, base URLs) is hardcoded with defaults in
  `config/config.js` so it need not live in Render. Prefer adding a default
  there over a new required env var.
- **Telegram sends**: go through `bot.telegram` (or the leads/staging clients).
  All clients are IPv4-pinned via `services/telegramAgent.js`. To deliver a
  message in its exact original format, use `copyMessage`.
- **Creator-only features**: gated by numeric Telegram user id
  `CREATOR_USER_ID = 2117922421` (in `bot/creatorMessageManager.js`), never by
  username.
- **Tests**: `npm test` runs `node --test tests/*.test.js` then Python tests.
  Tests stub Telegram/DB — no network or DB needed for most. A handful of tests
  currently fail only because they require live env/DB; those are pre-existing.
- **Git**: work on a feature branch, commit, push, open a PR, squash-merge to
  `main`. Render auto-deploys `main`.

## How to give a task

Tell the AI the symptom or feature and, if you know it, the surface (admin page,
bot command, or lead flow). It should: find the relevant `services/` or `bot/`
module (and its `database/db.js` queries), make the change, add/adjust a test in
`tests/`, run `npm test`, and — for anything user-facing — verify against the
real behavior before committing. Keep changes minimal and matched to the
surrounding style.
