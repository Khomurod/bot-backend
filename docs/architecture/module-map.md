# Module Map — `bot-backend` (Wenze Investments Operations Hub)

> **Purpose of this document.** This app has grown into one large, working
> production system. This map does **not** change any code. It records *where
> each feature already lives today* and proposes a **logical module structure**
> so future changes are easier to reason about and safer to make.
>
> **Read this first if you are about to change the app.** Find the feature you
> are touching, see which files it owns, read the "Risks" and "Do NOT touch yet"
> notes, and follow `docs/deployment/pre-deploy-checklist.md` before shipping.

## Guiding principles (do not violate)

1. **Reliability over novelty.** The best change is the smallest safe one.
2. **Structured API data first**, AI/OCR fallback second.
3. **Untrusted driver text is fenced** before being sent to any model
   (`services/aiAnalysisService.js`, `services/aiAnnotationService.js`).
4. **Idempotency is preserved** for every external send (Telegram, RingCentral,
   Bitrix24, Meta webhook, Datatruck). See the idempotency ledgers below.
5. **Retries stay safe**, with exponential backoff where already used.
6. This is a **modular monolith**, not microservices. One repo, one main
   deployment, plus two already-justified separate processes:
   - the **Python leads-bot** child process (`leads-bot/`), and
   - the **Samsara safety poller** in its own repo
     (`github.com/Khomurod/samsara-integration`), split out because its
     polling caused memory pressure / OOM in the main process.

## High-level runtime shape

```
index.js  ── orchestrates everything ──────────────────────────────┐
  ├── bot/            Telegraf bot (BOT_TOKEN, "Wenze Feedback")     │
  ├── server/         Express API + serves the React admin panel     │
  ├── services/       ~75 long-running services & feature logic       │
  ├── database/       Postgres pool + per-feature query helpers       │
  ├── admin/          React + Vite admin panel (built to admin/build) │
  ├── config/         config.js, tokens, Bitrix field maps            │
  └── leads-bot/      Python FastAPI child process (Meta/RingCentral) │  spawned + supervised
                                                                      │  (restart backoff + circuit breaker)
Separate repo: samsara-integration ── shares Postgres `groups` table ─┘  + shared Telegram tokens
```

`index.js` responsibilities: validate distinct Telegram polling tokens, run
`db.initializeDatabase()`, wire Telegram instances into the ETA / location /
Facebook services, start the Express server + Telegraf bot + ~13 background
services, spawn and supervise the Python leads-bot (exponential-backoff restart
+ circuit breaker; exit code 78 = permanent config error), and perform graceful
shutdown (stop services → SIGTERM/SIGKILL the child → drain the DB pool).

---

## Proposed logical modules → current files

The tables below map the **8 target modules** to the files that already
implement them. **Nothing has been moved.** These are logical owners, not new
folders. Treat this as the target structure that documentation-first
organization should converge toward.

### 1. Safety Module (mostly external)

| Concern | Current location |
|---|---|
| Samsara safety events, alerts, videos, safety captions, safety idempotency, poller retry | **External repo** `samsara-integration` (own Render service). See its `docs/architecture/module-map.md`. |
| Separation rationale | `samsara-separation.md`, `render.yaml` (note at bottom), `index.js:72-78` |

> **Do NOT re-add** the Samsara safety poller to this repo. It was removed on
> purpose to stop OOM kills. The two services cooperate only through the shared
> `groups` table and shared Telegram tokens — no in-process link.

### 2. Dispatch Module

| Concern | Current files |
|---|---|
| Unit-number & driver-name parsing from group titles | `services/driverGroupTitle.js` (central parser, reused widely) |
| Driver/unit fuzzy lookup vs group titles | `services/driverStatusLookupService.js` |
| Truck GPS fallback chain (Samsara → Factor ELD → Leader ELD) | `services/liveLocationResolver.js` (orchestrator, `withTransientRetries`) |
| Samsara GPS lookup | `services/samsaraLocationService.js` |
| Factor / Leader ELD (Drive HoS platform) | `services/driveHosEldService.js` |
| ETA / routing | `services/etaRoutingService.js`, `services/dispatchEtaUpdateService.js`, `services/dispatchPinnedContextService.js` |
| Datatruck active-load lookups | `services/datatruckLoadService.js`, `services/datatruckApiService.js`, `services/recentLoadSelection.js`, `services/loadTextPatterns.js`, `services/loadWindowParse.js`, `services/loadExtractionValidate.js` |
| Geocoding | `services/geocoder.js` |
| Dispatch Telegram commands (`/location`, `/status`, `/load`, `/update`) | `bot/dispatchStatusLookupHandlers.js`, `bot/dispatchStatusLookupSession.js` |
| Datatruck peer-bot reactions/banter | `bot/datatruckPeerHandlers.js`, `services/datatruckPeerBotService.js`, `services/datatruckPeerPatterns.js`, `services/datatruckBanterMessage.js` |
| Diagnostics | `services/dispatchTestingDiagnosticsService.js`, `server/services/dispatchParserService.js` |
| Admin API / UI | `server/routes/dispatchRoutes.js` (`/api/dispatch`), `admin/src/pages/DispatchPage.jsx` |

### 3. Recruiting / Lead Pipeline Module

| Concern | Current files |
|---|---|
| Meta/Facebook webhook front door (verification, leadgen, Messenger); RingCentral inbound SMS webhook | **Python** `leads-bot/webhook_server.py`, `graph.py`, `sms.py`, `config.py`, `main.py` (child process, `ENABLE_LEADS_BOT`) |
| Node raw-webhook proxy (preserves `X-Hub-Signature-256`) | `server/api.js` (`proxyToLeadsBot`, mounted before `express.json`) |
| Verified-payload queue + retry; **lead idempotency** (`facebook_webhook_events`, key `leadgen:<pageId>:<leadgen_id>`) | `services/facebookWebhookService.js` |
| Auto-SMS templates + two-way RingCentral reply mirroring | `services/facebookLeadAutoMessageService.js`, `facebookLeadSmsTemplate.js`, `facebookLeadSmsMirrorService.js`, `ringCentralSmsService.js` |
| Facebook OAuth self-serve connect, Graph client, crypto, formatting | `services/facebookConnectService.js`, `facebookGraphService.js`, `facebookCrypto.js`, `facebookLeadFormatter.js` |
| Bitrix24 CRM lead create/update + field mapping | `services/bitrix24Service.js`, `bitrix24LeadMapper.js`, `bitrix24FieldMapLoader.js`, `bitrix24FieldCatalog.js`, `config/bitrix24LeadFieldMap*.json` |
| Indeed lead intake | `services/indeedLeadService.js`, `docs/gmail-indeed-apps-script.gs` |
| Recruiter call KPI leaderboard | `services/recruiterCallSyncService.js`, `services/ringCentralCallService.js`, `server/routes/recruiterRoutes.js`, `database/ringcentral.js`, `admin/src/pages/RecruiterKpiPage.jsx`, `RecruitersPublicPage.jsx` |
| Leads admin UI/API | `server/routes/facebookLeadsRoutes.js`, `admin/src/pages/FacebookLeadsPage.jsx`, `LeadsPage.jsx` |

### 4. Driver Operations Module

| Concern | Current files |
|---|---|
| Feedback surveys (multilingual) | `bot/anonymousFeedbackHandlers.js`, questions/options/responses in `database/db.js`, `services/translationService.js`, admin `QuestionsPage.jsx` |
| Broadcasts & scheduled messages | `services/schedulerService.js`, `scheduledMessageUtils.js`, `broadcastTargetService.js`, `broadcastTemplateService.js`, `bot/creatorMessageManager.js`, admin `BroadcastPage.jsx`, `ScheduledMessagesPage.jsx`, `MessageManagerPage.jsx` |
| BOL/POD document delivery (idempotent) | `services/datatruckDocumentService.js`, `datatruckDocumentHelpers.js`, `database/datatruckDocuments.js` (`datatruck_document_deliveries`) |
| Fuel-stop reminders | `services/fuelStopAlertService.js`, `server/routes/fuelMonitorRoutes.js`, `fuel_stop_alerts` + `fuel_monitor_inbox`, admin `FuelMonitorPage.jsx` |
| Home-time tracking | `services/homeTimeService.js`, `homeTimeRequestService.js`, `homeTimeImportService.js`, `homeTimeConstants.js`, `bot/homeTimeRequestHandlers.js`, `server/routes/homeTimeRoutes.js`, `database/homeTime.js`, admin `HomeTimePage.jsx` |
| Birthdays (driver + employee) | `services/birthdayService.js`, `employeeBirthdayWishService.js`, `employeeBirthdayMessage.js`, `utils/birthdaySort.js`, `birthdays.csv`, `scripts/import-birthdays.js`, admin `CompanyBirthdaysPage.jsx` |
| Group auto-registration & status | `database/db.js` (`upsertGroup` / `reactivateGroupOnBotJoin` / `deactivateGroup`), `services/groupStatusAiService.js`, `groupStatusAiClassifier.js`, `driverGroupAiSyncService.js`, `driverGroupDirectoryService.js`, `driverProfileParse.js`, `driverProfileAiParser.js` |
| Location check-ins | `services/driverLocationMonitorService.js`, `bot/locationCheckinHandlers.js`, `server/routes/locationMonitorRoutes.js`, `database/driverLocationMonitors.js`, admin `LocationMonitorPage.jsx` |
| Central bot wiring & helpers | `bot/bot.js`, `services/recentMessageBuffer.js`, `telegramMention.js`, `telegramHtml.js`, `telegramUrl.js` |

> **Driver of the Week voting — REMOVED.** The employee "Driver of the Week"
> voting feature was retired. Its code (bot handlers, API routes, DB helper,
> admin page, API client functions) was deleted. The Postgres tables
> `employee_votes_polls`, `employee_votes_options`, `employee_votes` are
> intentionally **retained** in `database/schema.sql` (marked RETIRED) to
> preserve historical data; no code references them any more.

### 5. Payroll / Bonus / Approval Module

| Concern | Current files |
|---|---|
| Mileage bonus milestone payouts | `services/mileageBonusService.js`, `mileageBonusConstants.js`, `mileageBonusMessages.js`, `roadBonusNotifierService.js`, `bot/mileageBonusHandlers.js` (accounting-only Paid/Rejected buttons), `database/mileageBonus.js`, admin `MileageBonusPage.jsx` |
| 75¢/mile raise approval workflow | `services/raiseApprovalService.js` (round lifecycle + weekly schedule + public surface) over `services/raise/` (`notifications.js` = the two Telegram destinations, `dispatcherFlow.js` = the tokenized link flow, `teamRoster.js` = team drivers/members, `errors.js`), `server/routes/raiseRoutes.js` (public + admin), `database/raiseApproval.js`, admin `RaiseApprovalPage.jsx`, public `RaisePublicPage.jsx` |
| OTP verification (Gmail SMTP or RingCentral SMS) | `services/otpService.js`, `raise_otp` table |
| Approval audit trail / dispatch teams | tables `dispatch_teams`, `dispatch_team_drivers`, `raise_rounds`, `raise_round_submissions`, `raise_round_picks`, `raise_settings` |
| Raise Telegram routing (two audiences) | `database/messageRoutingSettings.js` categories `dispatchReview` (the review REQUEST → dispatch) and `raiseResults` (the submitted RESULT → accounting), admin `settings/TelegramGroupsTab.jsx` |

### 6. AI / Insights Module

| Concern | Current files |
|---|---|
| LLM clients (with per-provider model fallback) | `services/groqClient.js` (primary), `services/geminiClient.js` (cross-provider fallback) |
| AI management insights & rendering | `services/aiInsightsService.js`, `services/insightRenderer.js`, `services/aiAnalysisService.js` (weekly company/driver reports), `services/aiAnnotationService.js` (message classifier), admin `AiFeaturesPage.jsx` |
| **Prompt-injection protection / untrusted-text fencing** | `services/aiAnalysisService.js` (`<driver_transcript>` fence + `sanitizeTranscriptLine`), `services/aiAnnotationService.js` (`sanitizeForPrompt`) |
| Live Locations — map of all active units (location + load + ETA) | `services/liveLocationsService.js`, `server/routes/liveLocationsRoutes.js`, admin `LiveLocationsPage.jsx`; reuses `liveLocationResolver`/`samsaraLocationService`/`driveHosEldService`/`datatruckLoadService`/`etaRoutingService`/`geocoder`. See `docs/architecture/live-locations.md`. |
| Driver safety captions | **External** (`samsara-integration`), not in this repo |

> **Retired:** "Ask-the-Data" (`aiAskService.js`, `AskDataPanel.jsx`, `POST /api/ai-ask`)
> and "Chat Monitor" (`ChatLogsPage.jsx`, `GET /api/chat-logs`) were fully removed.
> See `docs/architecture/retired-ai-ask-chat-monitor.md`.

**AI safety invariants — verify before any AI change:**
- Untrusted driver transcripts are wrapped in fences and sanitized before the
  model sees them; the system prompt says to treat fenced content as data, never
  instructions. Covered by `tests/aiTranscriptFence.test.js`.

### 7. Admin / Settings Module

| Concern | Current files |
|---|---|
| React admin panel (Vite) | `admin/` → `admin/src/App.jsx`, `api.js`, `pages/*.jsx`, `components/Shared.jsx`; built to `admin/build/`, served at `/admin` |
| Settings (ELD creds, RingCentral, integrations) | `server/routes/settingsRoutes.js` (`/api/settings`), `database/eldSettings.js` |
| Permissions / feature toggles | `services/groupAccessService.js`, `groupAccessConstants.js`, `bot_access_settings` table, admin `GroupAccessPage.jsx`; env flags via `isEnabled()` in `index.js` |
| Logs / sent-message browser | `server/routes/botMessagesRoutes.js` (`/api/bot-messages`), `services/botMessageAdminService.js`, `admin/src/pages/BotMessagesPage.jsx` — database-backed; it does not read any log file |
| Health / config | `server/api.js` `/health` + `/api/health` (`runHealthCheck` pings DB + Meta creds), `config/config.js`, `config/telegramBotTokens.js`, `.env.example`, `render.yaml` |
| Auth | JWT (HS256-pinned `authMiddleware`), bcrypt login w/ per-IP rate limiting, `internalSharedSecretGuard` |

### 8. Shared Infrastructure Module

| Concern | Current files |
|---|---|
| DB pool/connection | `database/db.js` (single `pg.Pool`, `max=5`, SSL auto-detect, `initializeDatabase()` applies the baseline `schema.sql` then runs forward migrations via `database/migrate/`, `query()`, `ping()`) |
| Migration system | `database/migrate/` (runner + `schema_migrations` ledger), `database/baseline/*.sql` (baseline segments → generated `schema.sql`), `database/migrations/*.sql` (versioned run-once). See `docs/database/migration-notes.md`. |
| Per-feature DB helpers | `database/botUsers.js`, `mileageBonus.js`, `raiseApproval.js`, `homeTime.js`, `eldSettings.js`, `datatruckDocuments.js`, `driverLocationMonitors.js`, `ringcentral.js` |
| External API clients | Telegram (`bot/bot.js`), RingCentral (`services/ringCentralSmsService.js`, `ringCentralCallService.js`, `leads-bot/sms.py`), Bitrix24 (`services/bitrix24Service.js`), Samsara GPS (`services/samsaraLocationService.js`), Drive HoS/Factor/Leader ELD (`services/driveHosEldService.js`), Datatruck (`services/datatruckApiService.js`, `datatruckLoadService.js`), Meta Graph (`services/facebookGraphService.js`, `leads-bot/graph.py`), Groq/Gemini clients |
| **Idempotency ledger** — sent-message registry | `services/botSentMessageRegistry.js` (monkey-patches `telegram.callApi` → records every send/edit/copy/forward into `bot_sent_messages`). Comment: *"Never turn a successful Telegram send into a retry and duplicate."* |
| Retry / backoff / circuit breaker | `index.js` (child restart backoff + `isCircuitBroken`), `services/liveLocationResolver.js` (`withTransientRetries`), `groqClient.js`/`geminiClient.js` (retry-after honoring), safe-send wrapper in `bot/bot.js` |
| Logging / error handling | `console` structured prefixes (`[DB]`, `[API]`, `[LEADS]`, `[SHUTDOWN]`), global `uncaughtException` / `unhandledRejection` handlers (suppresses Telegram 409 polling conflicts) |

---

## Idempotency & dedupe ledgers (do not weaken)

| Table / mechanism | Guards against |
|---|---|
| `bot_sent_messages` (via `botSentMessageRegistry.js`) | Duplicate Telegram sends; also powers the admin message browser |
| `facebook_webhook_events` (key `leadgen:<pageId>:<leadgen_id>`) | Duplicate lead creation from Meta webhook |
| `facebook_seen_senders` | Duplicate Messenger sender handling |
| `facebook_lead_sms_mirrors` | Two-way SMS reply mis-routing / duplicates |
| `datatruck_document_deliveries` (UNIQUE signature) | Duplicate BOL/POD delivery |
| `service_runs` | Duplicate scheduled runs (e.g. weekly raise auto-send) |
| `fuel_monitor_inbox` (`ON CONFLICT (group_id, message_id) DO NOTHING`) | Duplicate fuel-monitor intake |
| `responses` (`ON CONFLICT (driver_id, question_id) DO NOTHING`) | Duplicate survey answers |
| `dispatch_eta_updates` / `fuel_stop_alerts` (`processing` claim + `FOR UPDATE SKIP LOCKED`) | Double-processing across instances |
| `mileage_bonus_runs` | Double milestone runs |

---

## Risks & "Do NOT touch yet" (for future refactors)

| Area | Risk | Guidance |
|---|---|---|
| `bot/bot.js` | Central Telegraf wiring; handler order matters (specific `bot.action` before generic `callback_query`). | Never reorder handlers casually. Add new handlers next to related ones. |
| `aiAnalysisService.js` / `aiAnnotationService.js` fencing | Removing the fence exposes prompt injection from driver chat. | Keep the `<driver_transcript>` fence + sanitizers. |
| `index.js` orchestration | Ordering/backoff/circuit-breaker prevent OOM restart loops. | Do not remove the circuit breaker or `--max-old-space-size` caps. |
| `database/db.js` (~3,500 lines) | Huge shared query surface used everywhere. | Split *by moving functions into existing per-feature `database/*.js` files one at a time*, re-exporting from `db.js` to preserve imports; run tests after each move. |
| `database/schema.sql` | GENERATED baseline (from `database/baseline/*.sql`), auto-applied on startup (`IF NOT EXISTS`). New changes go in `database/migrations/`, not here. | Never hand-edit `schema.sql` (run `npm run build:schema`). Never add destructive `DROP`/`ALTER ... DROP`. New columns must be nullable or defaulted. Back up before any manual migration. |
| Telegram polling tokens | Two bots must use distinct tokens (enforced in `index.js`). | Never share `BOT_TOKEN` with the leads bot or the Samsara service. |
| Samsara repo coupling | Both apps read the `groups` table. | A `groups` schema change affects **both** repos — check both before shipping. |

## Suggested (optional, future) move order — smallest & safest first

Documentation-first. Only do a code move if it is clearly low-risk, one module
at a time, tests green after each step, imports preserved (re-export shims), no
public function renames.

1. **Docs only (this PR).** This map + the pre-deploy checklist. No code moved.
2. **Consolidate DB helpers.** Move feature-specific query functions out of the
   monolithic `database/db.js` into the matching `database/<feature>.js`,
   re-exporting from `db.js` so every existing `require('database/db')` keeps
   working. One feature per PR.
3. **Group services by module** (optional, later) into `services/<module>/`
   subfolders (safety already external), updating `require` paths mechanically
   and running tests after each folder. Only if the team wants it — the flat
   `services/` folder works fine today.

**What should NOT be touched yet:** `bot/bot.js` internals, `index.js`
orchestration, the AI fencing, any idempotency
ledger, `schema.sql` table definitions, and the Samsara separation.

## How to run / test / build (verified from `package.json`)

| Task | Command |
|---|---|
| Install | `npm install` (root) — `postinstall` also builds the admin panel |
| Start (prod) | `node --max-old-space-size=256 index.js` |
| Dev | `npm run dev` |
| **Tests** | `npm test` → `node --test --test-concurrency=1 tests/*.test.js && python -m unittest discover -s leads-bot -p "test_*.py"` |
| Node tests only | `node --test --test-concurrency=1 tests/*.test.js` (85 files) |
| Admin build | `npm run build --prefix admin` |
| DB init / seed | `npm run init-db`, `npm run seed-admin` |

Deployment target: **Render** (`render.yaml`) — two services here
(`driver-feedback-bot` Node web + `facebook-leads-engine` Python web); the
Samsara poller deploys from its own repo.
