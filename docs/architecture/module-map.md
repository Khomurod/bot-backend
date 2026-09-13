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
| Samsara safety events, alerts, videos, safety captions, safety idempotency, missing-video recovery | **External repo** `samsara-integration` (own Render service). See its `docs/architecture/module-map.md`. |
| **Its settings**, and the schema for them | **Here.** `database/samsaraSettings.js`, `server/routes/settings/samsaraRoutes.js`, `admin/src/pages/settings/SamsaraTab.jsx`, migration 0013 |
| The recovery queue, read-only for diagnostics | `database/samsaraVideoRecovery.js` (never writes — the poller owns the jobs) |
| The envelope both services open the Samsara API key with | `lib/security/sharedIntegrationCrypto.js` (mirrored in the other repo) |
| Separation rationale | `samsara-separation.md`, `render.yaml` (note at bottom), `index.js:72-78` |
| Settings + recovery contract | `samsara-settings-and-video-recovery.md` |

> **Do NOT re-add** the Samsara safety poller to this repo. It was removed on
> purpose to stop OOM kills. The two services cooperate only through the shared
> database and shared Telegram tokens — no in-process link, and **no HTTP link
> either**: `samsara_settings` is the configuration channel, and adding a second
> one is how the panel and the poller end up disagreeing.

### 2. Dispatch Module

| Concern | Current files |
|---|---|
| **Telegram identity** — which account is which human | the rule: `lib/identity/telegramResolution.js`; the table: `database/driverPeople/telegramIdentities.js` (migration 0049); the check: `services/operations/checks/telegramIdentity.js`; the write: `services/operations/corrections/telegramActions.js` |
| Unit-number & driver-name parsing from group titles | `lib/drivers/driverGroupTitle.js` (central parser, reused widely) |
| **The Dispatcher Board** — the authority on today's assignment | pure: `lib/board/{parse,truck,rowKey}.js`, `lib/drivers/fleetType.js`; settings: `database/dispatchBoardSettings.js`, `server/routes/settings/dispatchBoardRoutes.js`, `admin/src/pages/settings/DispatcherBoardTab.jsx` + `settings/dispatcherBoard/FeedCard.jsx` (and `EtaTrackingCard.jsx`, which arrived with the Dispatch Center's removal rather than by design); transport: `services/dispatchBoard/client.js`; the snapshot and its ONE writer: `database/dispatchBoard.js`, `services/dispatchBoard/poller.js`; checks: `services/operations/checks/board.js`; person linking: `lib/identity/boardResolution.js` (the rule, pure), `services/operations/checks/boardLink.js`, `services/operations/corrections/boardActions.js`; what a status MEANS: `lib/board/statusSemantics.js`, read by `lib/drivers/context.js` and `database/driverContext.js readBoard` |
| **The control channel** — answering Wenze in Telegram | pure: `lib/control/{intent,askable,fingerprint}.js`; data: `database/{controlSettings,controlOperators,controlReplies,controlKnowledge}.js` + the question columns and health counts in `database/operationalNotifications.js` → `operationalNotificationHealth.js`; asking: `services/control/askPass.js` (on the consistency timer); answering: `bot/controlReplyHandlers.js` → `services/control/replyHandler.js` → `services/control/actions.js` (the ONLY writer); reading a reply the rules could not: `services/control/aiIntent.js` (the one AI seam, reached only on `unclear`); remembering: `services/control/memory.js`; admin: `server/routes/settings/controlRoutes.js`, `admin/src/pages/settings/control/{ControlChannelCard,RememberedAnswers}.jsx` |
| **The Groups page** — five views over one list | the classifier: `admin/src/pages/groups/driverProfileShaping.js groupView`; the page: `admin/src/pages/GroupsPage.jsx` + `groups/*`; the board and open questions beside each row: `database/driverGroupDirectory.js`; retyping a chat: `services/operations/corrections/groupActions.js` |
| Driver/unit fuzzy lookup vs group titles | `services/driverStatusLookupService.js` |
| Truck GPS fallback chain (Samsara → Factor ELD → Leader ELD) | `services/liveLocationResolver.js` (orchestrator, `withTransientRetries`) |
| Samsara GPS lookup | `services/samsaraLocationService.js` |
| Factor / Leader ELD (Drive HoS platform) | `services/driveHosEldService.js` |
| ETA / routing | `services/etaRoutingService.js`, `services/dispatchEtaUpdateService.js`, `services/dispatchPinnedContextService.js` |
| Datatruck active-load lookups | `services/datatruckLoadService.js`, `services/datatruckApiService.js`, `services/recentLoadSelection.js`, `services/loadTextPatterns.js`, `services/loadWindowParse.js` |
| Geocoding | `services/geocoder.js` |
| Dispatch Telegram commands (`/location`, `/status`, `/load`, `/update`) | `bot/dispatchStatusLookupHandlers.js`, `bot/dispatchStatusLookupSession.js` |
| Datatruck peer-bot reactions/banter | `bot/datatruckPeerHandlers.js`, `services/datatruckPeerBotService.js`, `services/datatruckPeerPatterns.js`, `services/datatruckBanterMessage.js` |
| Rate-con text extraction (for pinned context) | `server/services/dispatchParserService.js` `extractRateConRawTextFromFile` + `dispatchParser/{textExtraction,constants}.js` — the model-read half went with the Dispatch Center |
| Automatic ETA updates — admin API / UI | `server/routes/dispatchEtaRoutes.js` (`/api/dispatch/testing-feature/*`), `admin/src/pages/settings/dispatcherBoard/{EtaTrackingCard.jsx,useEtaTracking.js,ToggleSwitch.jsx,helpers.js}` on the Dispatcher Board settings tab |
| **Retired** | The Dispatch Center at `/dispatch` — Send Load, its rate-confirmation parser, and the per-group diagnostics expander. `docs/architecture/retired-dispatch-center.md` |

### 3. Recruiting / Lead Pipeline Module

| Concern | Current files |
|---|---|
| Meta/Facebook webhook front door (verification, leadgen, Messenger); RingCentral inbound SMS webhook | **Python** `leads-bot/webhook_server.py`, `graph.py`, `sms.py`, `config.py`, `main.py` (child process, `ENABLE_LEADS_BOT`) |
| Node raw-webhook proxy (preserves `X-Hub-Signature-256`) | `server/api.js` (`proxyToLeadsBot`, mounted before `express.json`) |
| Verified-payload queue + retry; **lead idempotency** (`facebook_webhook_events`, key `leadgen:<pageId>:<leadgen_id>`) | `services/facebookWebhookService.js` |
| Auto-SMS templates + two-way RingCentral reply mirroring | `services/facebookLeadAutoMessageService.js`, `facebookLeadSmsTemplate.js`, `facebookLeadSmsMirrorService.js`, `ringCentralSmsService.js` |
| One lead event: post → CRM → record → text | `services/facebookLeadEventProcessor.js` (the queue that runs it stays in `facebookWebhookService.js`) |
| **Whose number texts a lead** (Bitrix assignee → recruiter → send) | `services/facebookLeadSmsSender.js`, `services/bitrix24Service.js` (`waitForCrmAssignee`), `database/ringcentral/recruiters.js` (`bitrix_user_id`, `recruiterCanSendSms`) |
| Per-recruiter RingCentral credentials → an access token | `services/ringCentralOAuthService.js` (the only place a JWT or a refresh token becomes a bearer token) |
| Recruiter self-onboarding ("sign in with RingCentral") | `services/ringCentralConnectService.js`, `server/routes/ringcentralConnect/{index,pages}.js`, `database/ringcentral/connectSessions.js` |
| Keeping recruiter logins alive (7-day refresh tokens) | `services/ringCentralTokenRefreshService.js` |
| Keeping the inbound-SMS subscription in step with the roster | `leads-bot/webhook/rc_subscription.py` |
| Facebook OAuth self-serve connect, Graph client, crypto, formatting | `services/facebookConnectService.js`, `facebookGraphService.js`, `facebookCrypto.js`, `facebookLeadFormatter.js` |
| Bitrix24 CRM lead create/update + field mapping | `services/bitrix24Service.js`, `bitrix24LeadMapper.js`, `bitrix24FieldMapLoader.js`, `bitrix24FieldCatalog.js`, `config/bitrix24LeadFieldMap*.json` |
| Bitrix24 settings entered in the app (DB over env, webhook encrypted) | `database/bitrix.js`, `database/migrations/0009_bitrix_settings.sql`, `server/routes/settings/bitrixRoutes.js` (GET/PUT), `admin/src/pages/settings/ringcentral/BitrixSettingsForm.jsx` |
| "Is Bitrix aligned?" — the admin diagnosis | `services/bitrix24DiagnosticsService.js`, `server/routes/settings/bitrixRoutes.js`, `admin/src/pages/settings/ringcentral/BitrixCard.jsx` |
| Mapping recruiters to Bitrix users (the automap + the row picker) | `services/recruiterBitrixMapping/` (`directory.js` reads `user.get`, `match.js` is the pure decision, `index.js` previews and applies), `server/routes/recruiter/bitrixMappingRoutes.js`, `admin/src/pages/settings/ringcentral/BitrixAutomapPanel.jsx`, `RecruiterCard.jsx` |
| Indeed lead intake | `services/indeedLeadService.js`, `docs/gmail-indeed-apps-script.gs` |
| Recruiter call KPI leaderboard | `services/recruiterCallSyncService.js`, `services/ringCentralCallService.js`, `server/routes/recruiterRoutes.js`, `server/routes/recruiter/diagnosticsRoutes.js`, `database/ringcentral.js`, `admin/src/pages/RecruiterKpiPage.jsx`, `RecruitersPublicPage.jsx`, `admin/src/pages/settings/ringcentral/RecruiterCard.jsx` |
| Leads admin UI/API | `server/routes/facebookLeadsRoutes.js`, `admin/src/pages/FacebookLeadsPage.jsx`, `LeadsPage.jsx` |

### 4. Driver Operations Module

| Concern | Current files |
|---|---|
| Feedback surveys (multilingual) | `bot/anonymousFeedbackHandlers.js`, questions/options/responses in `database/db.js`, `services/translationService.js`, admin `pages/communications/SurveysTab.jsx` |
| Broadcasts & scheduled messages | `services/schedulerService.js`, `scheduledMessageUtils.js`, `broadcastTargetService.js`, `broadcastTemplateService.js`, `bot/creatorMessageManager.js`, admin `pages/communications/{SendMessageTab,ScheduledTab,EditByLinkTab}.jsx` (+ `communications/broadcast/*`) |
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
> `employee_votes_polls`, `employee_votes_options`, `employee_votes` keep their
> historical data on existing deployments, but are **no longer created** by
> `database/baseline/` — Settings → Retired Leftovers can drop them, and a
> baseline that recreates a droppable table would undo the drop on the next
> boot. No code references them either way.

### 5. Payroll / Bonus / Approval Module

| Concern | Current files |
|---|---|
| Mileage bonus milestone payouts | `services/mileageBonusService.js`, `mileageBonusConstants.js`, `mileageBonusMessages.js`, `roadBonusNotifierService.js`, `bot/mileageBonusHandlers.js` (accounting-only Paid/Rejected buttons), `database/mileageBonus.js`, admin `MileageBonusPage.jsx` |
| 75¢/mile raise approval workflow | `services/raiseApprovalService.js` (round lifecycle + weekly schedule + public surface) over `services/raise/` (`notifications.js` = the two Telegram destinations, `dispatcherFlow.js` = the tokenized link flow, `teamRoster.js` = team drivers/members, `errors.js`), `server/routes/raiseRoutes.js` (public + admin), `database/raiseApproval.js`, admin `RaiseApprovalPage.jsx`, public `RaisePublicPage.jsx` |
| OTP verification (Gmail SMTP or RingCentral SMS) | `services/otpService.js`, `raise_otp` table |
| Approval audit trail / dispatch teams | tables `dispatch_teams`, `dispatch_team_drivers`, `raise_rounds`, `raise_round_submissions`, `raise_round_picks`, `raise_settings` |
| Raise Telegram routing (two audiences) | `database/messageRoutingSettings.js` categories `dispatchReview` (the review REQUEST → dispatch) and `raiseResults` (the submitted RESULT → accounting), admin `settings/TelegramGroupsTab.jsx` |

### 5a. Finance Monitor Module

| Concern | Current files |
|---|---|
| Reading a money code out of a message, and deciding whether it repeats one | `lib/finance/moneycode.js` (`PARSER_VERSION`, `STATUS`), `lib/finance/duplicates.js` (`REASON`, `decideDuplicate`) — both pure |
| Which group is read, and the rule that it cannot be read until validated | `database/financeSettings.js`, `server/routes/settings/financeRoutes.js`, admin `settings/FinanceTab.jsx` |
| Storing what was said, and what was read out of it | `database/financeMessages.js`, tables `finance_settings`, `finance_messages`, `finance_moneycodes` (migration 0052) |
| The capture decision, and the bot seam above it | `services/finance/captureService.js`, `bot/handlers/financeCaptureHandlers.js` (thin: no chat id, no parser, no query) |
| Deciding what may be read, and what a reading means | `lib/finance/documentPolicy.js` (intake, read path, outcome, backoff), `lib/finance/documentPrompt.js` (the fenced prompt, the validator, the whitelist) — both pure |
| Reading the attachments, one at a time | `services/finance/documentReader.js`, `services/finance/telegramFileDownload.js`, table `finance_documents` (migration 0053), worker key `finance_document_reader` |
| Getting text out of a PDF or an image | `services/documents/pdfTextExtraction.js` — shared with the pinned rate-confirmation reader; `allowOcr: false` is how finance keeps tesseract.js off its path entirely |
| The photo/document shapes of a Telegram message | `lib/telegram/fileDescriptor.js` — moved out of `services/pinnedContext/pinnedSource.js`, which re-exports it |

Deliberately isolated: no foreign key out of the finance tables, no reader
anywhere else, and nothing it stores feeds a decision. See
[`finance-monitor.md`](finance-monitor.md).

### 6. AI / Insights Module

| Concern | Current files |
|---|---|
| LLM clients | `services/groqClient.js` and `services/geminiClient.js` are **compatibility façades** over `services/ai/router.js` since Stage 5c — they own the vocabulary their ~40 call sites use (model chains from the environment, the rate-limit/auth predicates, Gemini's JSON helpers) and no transport at all. The direct fetch loops were deleted rather than left beside the router: two live paths to one API is how the two stop agreeing, and the unexercised one is the one that rots. |
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
| **Which page the panel is on** | `admin/src/navigation/pageKeys.js` (pure) owns the vocabulary: `PAGE_KEYS`, `LEGACY_PAGE_KEYS` for keys that became tabs, `resolvePageKey`, and the hash helpers. `App.jsx` `PAGE_COMPONENTS` says what each key renders; `components/AdminSidebar.jsx` `NAV_SECTIONS` says where each key appears. **Those three lists are the same vocabulary authored three times and `navigation/pageKeys.test.jsx` holds them to each other** — a typo used to miss the lookup and render Driver Groups in silence. The admin page is the URL HASH (`/admin#fuel_monitor`); the path only chooses between the admin shell and the two public pages. |
| Settings (ELD creds, RingCentral, integrations) | `server/routes/settingsRoutes.js` (`/api/settings`), `database/eldSettings.js` |
| Permissions / feature toggles | `services/groupAccessService.js`, `groupAccessConstants.js`, `bot_access_settings` table, admin `GroupAccessPage.jsx`; env flags via `isEnabled()` in `index.js` |
| Logs / sent-message browser | `server/routes/botMessagesRoutes.js` (`/api/bot-messages`), `services/botMessageAdminService.js`, `admin/src/pages/communications/HistoryTab.jsx` — database-backed; it does not read any log file |
| Health / config | `server/api.js` `/health` + `/api/health` (`runHealthCheck` pings DB + Meta creds), `config/config.js`, `config/telegramBotTokens.js`, `.env.example`, `render.yaml` |
| Auth | JWT (HS256-pinned `authMiddleware`), bcrypt login w/ per-IP rate limiting, `internalSharedSecretGuard` |
| Presenter remote | `server/routes/remoteRoutes.js` (`/remote` plus an explicit allow-list for `remote.css`, `remote-mqtt.js`, `remote-app.js`). It pairs through a **public MQTT broker** and keeps no server state at all, because the deck it controls is a standalone file that can run from a laptop's file system. `docs/brief/features.md` §4 holds the wire protocol; `tests/remoteMqttLite.test.js` asserts its bytes. (A second hosted deck at `/qbq`, which paired through this server over SSE, went with QBQ/SOS.) |
| Public product page | `server/routes/healthRoutes.js` serves `/presentation` plus an explicit allow-list for `presentation.css` and three scripts split along real seams: `presentation-engine.js` (map projection, generated world SVG, marker primitives), `presentation-scroll.js` (the scroll/scene framework and the EN/RU state), `presentation-scenes.js` (the scenes, which register with both). `tests/presentationPage.test.js` guards the load order and the asset allow-list |

### 8. Shared Infrastructure Module

| Concern | Current files |
|---|---|
| DB pool/connection | `database/pool.js` is the **single** place the `pg.Pool` is created (`max=5`, SSL auto-detect, `query()`, `ping()`); per-feature `database/*.js` modules require it directly so the module graph stays acyclic. Being the single query boundary, it also does two things for every query: feeds the transfer meter (below) and tags an infrastructure failure with `dbFailure` so a route can name the cause. Neither can fail a query, and the error object is rethrown unchanged (`err.code` stays the SQLSTATE). `database/db.js` re-exports pool/query/ping for the legacy `require('./db')` seam and owns `initializeDatabase()` (baseline `schema.sql`, then forward migrations via `database/migrate/`). |
| Migration system | `database/migrate/` (runner + `schema_migrations` ledger), `database/baseline/*.sql` (baseline segments → generated `schema.sql`), `database/migrations/*.sql` (versioned run-once). See `docs/database/migration-notes.md`. |
| Per-feature DB helpers | 51 focused modules under `database/` (one per table family, each requiring `pool.js` directly) — e.g. `database/botUsers.js`, `mileageBonus.js`, `raiseApproval.js`, `homeTime.js`, `eldSettings.js`, `datatruckDocuments.js`, `driverLocationMonitors.js`, `ringcentral.js` |
| External API clients | Telegram (`bot/bot.js`), RingCentral (`services/ringCentralSmsService.js`, `ringCentralCallService.js`, `leads-bot/sms.py`), Bitrix24 (`services/bitrix24Service.js`), Samsara GPS (`services/samsaraLocationService.js`), Drive HoS/Factor/Leader ELD (`services/driveHosEldService.js`), Datatruck (`services/datatruckApiService.js`, `datatruckLoadService.js`), Meta Graph (`services/facebookGraphService.js`, `leads-bot/graph.py`), Groq/Gemini clients |
| **Idempotency ledger** — sent-message registry | `services/botSentMessageRegistry.js` (monkey-patches `telegram.callApi` → records every send/edit/copy/forward into `bot_sent_messages`). Comment: *"Never turn a successful Telegram send into a retry and duplicate."* |
| Retry / backoff / circuit breaker | `index.js` (child restart backoff + `isCircuitBroken`), `services/liveLocationResolver.js` (`withTransientRetries`), `services/ai/router.js` + `lib/ai/{classify,cooldown}.js` (AI retry-after, failure classification and per-provider cooldown), safe-send wrapper in `bot/bot.js` |
| Background wake scheduling | `services/jobQueueScheduler.js` (durable queues: drain on the producer's event, arm one timer for the earliest due row, slow idle sweep as the backstop), `services/dueTimeWakeTimer.js` (weekly jobs with a stored `next_run_at`), `services/dailyWakeSchedule.js` (once-a-day jobs). All sleeps are capped so a config change applies without a restart; a failed send re-arms on the short retry cadence. Replaced the fixed 5s/15s/60s polls — see `APP_BRIEF.md` §7. |
| Outbound AI image preparation | `services/aiImagePrep.js` — EXIF-rotate, bound the long edge, re-encode JPEG, strip metadata for **every** image sent to a model. Shrinks only the transient outbound copy; stored originals stay untouched. Do not add a `toString('base64')` image path that bypasses it. |
| Logging / error handling | `console` structured prefixes (`[DB]`, `[API]`, `[LEADS]`, `[SHUTDOWN]`), global `uncaughtException` / `unhandledRejection` handlers (suppresses Telegram 409 polling conflicts), and `server/middleware/failureResponse.js` — `sendFailure()` for a handler's own catch plus the **terminal Express error handler**, mounted last in `server/api.js`. Before it, an error escaping a handler produced Express's HTML stack page, which the admin's fetch layer misread as a stale bundle. |
| **Failure classification** | `lib/database/failureClassification.js` (pure) turns a pg/socket error into `DB_UNAVAILABLE` / `DB_TIMEOUT` / `DB_QUOTA` / `DB_PERMISSION` + a 503 and a human sentence; an ordinary SQL error stays unclassified on purpose. `admin/src/utils/pageFailure.js` is the browser half of the same vocabulary, and `admin/src/components/{PageFailure,PageErrorBoundary}.jsx` render it per section. |
| **Settings tabs that are not integrations** | `admin/src/pages/settings/NotificationsTab.jsx` (where Wenze's own notices go + the channel it can be answered on — moved off Telegram Groups, which is about the routine per-workflow group ids) and `settings/bot/{AutoReactionsPanel,GroupAccessPanel}.jsx` as **two tabs with a page key each** — grouping them under one key resolved a held `#group_access` link and then opened the other screen. All three were top-level sidebar entries or buried in another tab before. |
| **Database transfer meter** | `database/transferMeter.js` (in-memory accounting, no I/O — so `pool.js` can call it without a cycle), `database/transferUsage.js` (persists to `database_transfer_usage`, one row per UTC month), `services/databaseUsageService.js` (60s flush + one warning per threshold at 80/90/95%), `server/routes/systemRoutes.js` (`GET /api/system/database-usage`, in-memory, no query), `admin/src/components/DatabaseUsageBanner.jsx` — the ONE component `App.jsx` renders outside `PageErrorBoundary`, so it guards its own payload shape (`usable()`) and can never throw: a render error there would unmount the whole panel with nothing to catch it. Estimates, clearly labelled as such; **never throttles a query**. See `APP_BRIEF.md` §7. |
| **Pure helpers / constants** — the bottom layer | `lib/` — modules with no I/O and no mutable state, in domain subdirectories: `lib/security/facebookCrypto.js`, `lib/rbac/roleKeys.js`, `lib/drivers/{driverGroupTitle,driverProfileParse}.js`, `lib/telegram/telegramUsername.js`, `lib/routeControl/routeControlConstants.js`, `lib/geo/distance.js`, `lib/database/failureClassification.js`. They used to live in `services/`, a layer ABOVE the database, which forced nineteen `database/**` modules to depend upward; `database/**` now depends on nothing above it. See [`lib/README.md`](../../lib/README.md) for the charter and the rule for adding to it. |

---

## Façade + package shape (where a named file is now a directory)

Many entries above name a file that is a **composition-or-re-export-only
façade** over a sibling package. The import path is the stable seam; the
implementation is one module per responsibility. No hand-written file in the
repository exceeds 500 lines (`npm run lint:filesize`, no baseline).

| Façade (stable import path) | Package |
|---|---|
| `database/homeTime.js` | `database/homeTime/{settings,driverState,roadHistory,requests}.js` |
| `database/facebookLeads.js` | `database/facebookLeads/{connectSessions,pageConnections,webhookEvents,autoMessages,recruiterMessages,smsMirrors}.js` |
| `database/raiseApproval.js` | `database/raiseApproval/{settings,teams,teamMembers,teamDrivers,rounds,otp}.js` |
| `database/ringcentral.js` | `database/ringcentral/{kpiMath,secrets,settings,recruiters,calls,kpiQueries,connectSessions}.js` — **explicit key list**, so four internal helpers stay private |
| `database/routeControl.js` | `database/routeControl/{assignments,screenshots,monitorState,driverMessages,monitorEvents}.js` |
| `server/routes/settingsRoutes.js` | `server/routes/settings/{eld,ringcentral,messageGroup,gmaps,samsara,safetyEvent,bolPod,bitrix,retiredLeftovers}Routes.js` |
| `server/routes/homeTimeRoutes.js` | `server/routes/homeTime/{rowShaping,tracker,import,settings,groupAccess}Routes.js` — registration ORDER is load-bearing |
| `server/routes/facebookConnectRoutes.js` | `server/routes/facebookConnect/{connectPages,internal,oauth,inspection}Routes.js` — one guard per file, three different auth models |
| `server/services/dispatchParserService.js` | `server/services/dispatchParser/{constants,textExtraction}.js` — was 9 modules; the seven that read a rate confirmation with a model went with the Dispatch Center |
| `services/dispatchPinnedContextService.js` | `services/pinnedContext/*.js` |
| `services/liveLocationsService.js` | `services/liveLocations/*.js` |
| `services/aiInsightsService.js` | `services/aiInsights/*.js` |
| `services/fuelStopAlertService.js` | `services/fuelStop/*.js` — `telegramClient.js` is the single owner of the shared client |
| `services/mileageBonusService.js` | `services/mileageBonus/*.js` — `runState.js` owns the run lock |
| `bot/senders.js` | `bot/senders/{messageText,mediaSender,questionSenders,broadcastSenders,confirmationSenders}.js` |
| `leads-bot/webhook_server.py` | `leads-bot/webhook/{state,meta_signature,hub_client,telegram_client,connect_command,ringcentral,lead_processing}.py` |

Admin pages follow the same shape — a container that only lays out and wires,
over `admin/src/pages/<area>/` holding data hooks and presentational sections:
`dispatch/`, `homeTime/`, `broadcast/`, `routeControl/`, `liveLocations/`,
`groups/`, `facebookLeads/`, `raiseApproval/`, plus
`admin/src/components/shared/` for the message-composer pieces.

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
| `finance_messages` (`ON CONFLICT (chat_id, message_id) DO NOTHING`) and `finance_moneycodes` (`ON CONFLICT (message_ref_id, code_normalized)`) | A redelivered or replayed finance message becoming a second row, or a re-read double-counting a code |
| `finance_documents` (UNIQUE `(chat_id, message_id, file_unique_id)`; claimed with `FOR UPDATE SKIP LOCKED` + attempts counted at claim) | The same attachment queued twice, two readers taking one document, and a crash loop retrying a poisoned row forever |

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
| **Tests** | `npm test` → `npm run lint:undef && npm run lint:imports && node --test --test-concurrency=1 tests/*.test.js && python -m unittest discover -s leads-bot -p "test_*.py"` |
| Scope gates | `npm run lint:undef` (undefined identifiers — the check a build is not), `npm run lint:imports` (an import naming something its module does not export) |
| Node tests only | `node --test --test-concurrency=1 tests/*.test.js` (85 files) |
| Admin build | `npm run build --prefix admin` |
| DB init / seed | `npm run init-db`, `npm run seed-admin` |

Deployment target: **Render** (`render.yaml`) — two services here
(`driver-feedback-bot` Node web + `facebook-leads-engine` Python web); the
Samsara poller deploys from its own repo.
