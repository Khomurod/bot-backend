<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list. -->

# §6. Integrations and configuration

| Integration | Config source | Used by | Failure behavior |
|---|---|---|---|
| **Telegram** (Telegraf 4) | `BOT_TOKEN`, group IDs in `config/config.js`; IPv4 agent | everything | `safeSend` does 429-aware retries with backoff and rethrows permanent errors (403 / chat not found / deactivated / upgraded) immediately — it does **not** downgrade HTML to plain text; a feature that wants that fallback does it itself (the ETA updates did, until they were removed in October 2026). 409 polling conflicts are suppressed, not fatal |
| **Datatruck** (the company TMS, read-only) | `DATATRUCK_API_TOKEN`, `DATATRUCK_COMPANY` | loads (the application's only lookup of a driver's current load since the pinned-load reading was removed on 2026-10-23 — `docs/architecture/retired-dispatch-eta.md`; the Dispatcher Board is the dispatchers' own sheet, which the application reads only for Home Time), Live Locations, the load lifecycle watch, mileage bonus, return-to-road detection, the Gross Grand Prix displays (read by the server, never the page). BOL/POD forwarding was removed in October 2026 (`docs/architecture/retired-bol-pod.md`) | features skip the tick or show no load; there is no pinned-message or chat-history fallback any more |
| **Samsara + Drive HoS ELD** | admin **Settings** takes precedence over env. The **Samsara** credential lives in `samsara_settings` (Settings → Samsara) and is shared with the poller; Drive HoS keys and the provider switches stay in `eld_settings`. A Samsara key typed on the Live Location tab is written to `samsara_settings` too, so the two screens cannot disagree | `/location`, live map and its ETA, return-to-road detection, the load watch, duplicate-unit check. (Fuel alerts were removed in October 2026, and the stats request now asks for `gps` only — `docs/architecture/retired-fuel.md`; `/status` and the ETA updates on 2026-10-23) | GPS fallback chain **Samsara → Factor ELD → Leader ELD** with transient retries (`services/liveLocationResolver.js`) |
| **Dispatcher Board** (external Google Apps Script over the dispatchers' own sheet, read-only) | Settings → Dispatcher Board (`dispatch_board_settings`, single row, token encrypted). **No env fallback and `enabled` defaults FALSE** — there is nothing to inherit and an integration that switches itself on at deploy starts making requests nobody reviewed | Home Time's home-in / home-out only: the status column, read through `services/homeTime/boardPresenceWatch.js` (nothing else reads the Board since October 2026) | read every 5 minutes (60–3600s, configurable) by `services/dispatchBoard/poller.js` into `dispatch_board_rows` — the only writer of that snapshot — and by nothing else. Nothing is read until a URL and token are saved. **The token travels in the query string**, so every error leaves through `lib/security/redactUrls.stripUrls` and `last_error` can never hold a URL; exactly one redirect is followed and the token is not re-attached to it. See [`docs/architecture/dispatcher-board.md`](../architecture/dispatcher-board.md) |
| **Safety Approvals** (the recruiting Telegram group: read; post in one topic; ask Safety in General when a decision cannot be placed) | Settings → Safety Approvals (`safety_approval_settings`, single row): the group, the approved / not approved topic, and the Telegram ids of the Safety people. **`enabled` defaults FALSE, inherits nothing from env**, and needs all three | Safety's hire decisions posted per driver: the recruiter's post (CDL photos and words) with the decision and who made it | the bot must be an admin of the group (or have privacy mode off) to see posts. Capture is an observer that never consumes a message or throws at the bot; a `#Approved` / `#NotApproved` hashtag decides with no model; without one, a model reads Safety's words and `lib/safetyApprovals/reading.js` keeps only what the messages prove. See [`docs/architecture/safety-approvals.md`](../architecture/safety-approvals.md) |
| **Google Maps** (Routes + Geocoding) | `GOOGLE_MAPS_API_KEY` (environment only — Settings → GMaps went with Route Control) | Live Locations' ETA routing and geocoding, as one option among free OpenStreetMap services | OSRM / Nominatim / Photon answer instead, then a straight-line estimate |
| **Meta / Facebook** | `META_*`, `WEBHOOK_VERIFY_TOKEN`, `FACEBOOK_TOKEN_ENCRYPTION_KEY` | lead capture, Page connect | events are persisted before processing, then retried |
| **Meta Conversions API (CRM)** | **Entered, tested and saved in Settings → Facebook ↔ Bitrix** (`meta_crm_settings`, single row, token encrypted, the panel sees its last four characters only); `META_CRM_DATASET_ID`, `META_CRM_CAPI_TOKEN` are the fallback for a value never saved — the DB row wins once set. The token travels in a request body (or the `Authorization` header for the dataset read), never a URL, and is scrubbed from every error text (`docs/architecture/meta-crm-settings.md`) | reporting each Facebook lead's hiring stage back to Meta — Qualified / Converted / Lost, keyed by the leadgen id alone (no name, phone or e-mail) — so ad delivery learns which leads become drivers (`services/metaCrm/stageSync.js`) | `blocked` while switched off in Settings or until both values exist; one event per request; five attempts or Meta's seven-day window, then `gave_up`; a pass where every send failed is a failed run |
| **RingCentral** | `RC_*` env → shared pair in `ringcentral_settings`; **per-recruiter** creds live on the `recruiters` row — an OAuth refresh token (preferred) or its own JWT, plus an optional custom client pair (`resolveRecruiterRcAuth` picks: `oauth` > `jwt` > `none`) | lead auto-SMS **as the assigned recruiter**, two-way mirroring, recruiter call KPIs | per-recruiter send falls back to the shared number and says so; refresh tokens are renewed daily and a dead grant is flagged `rc_auth_error`; the inbound subscription carries one `instant?type=SMS` filter per watched extension (pictures arrive through it; RingCentral has no MMS filter) and sheds one recruiter extension at a time if refused (never for a transient error); an `Active` subscription is kept, and a replaced one is deleted only after its successor exists |
| **AI: Anthropic Claude** (October 2026, paid) | Settings → AI → Add a provider → Anthropic Claude (key encrypted in `ai_providers`); `ANTHROPIC_API_KEY` is the env fallback | any AI responsibility, in the place an operator gives it in **Order of providers** — first is primary, the rest fall back in turn | through the shared router like every provider: a failure moves to the next model, then the next provider; **skipped entirely while "Free tiers only" is on**. See [§4b](ai-gateway.md) |
| **Bitrix24 CRM** | **Entered in Settings → RingCentral → Bitrix24** and stored in `bitrix_settings` (single row, webhook encrypted); `BITRIX24_*` env vars are the fallback for anything never saved — the DB row wins once set. The field maps stay file/env-based in `config/`. **The assignee must be a NUMERIC user id** — a name there is ignored by Bitrix, so leads go to the webhook owner; the form refuses a name, the mapper warns once, and the card reports an env-supplied name as ignored | dual delivery of every Facebook lead, **and reading back who owns it** (`crm.lead.get` → `ASSIGNED_BY_ID`) to pick the SMS sender; and **moving a candidate's deal to another stage** (`crm.deal.update`, `STAGE_ID` only) — only when a person presses Move on a proposal in the recruiting group (`docs/architecture/hiring-stage-proposals.md`); and **reading pipeline 0's recently changed deals** (`crm.deal.list`, never a write) to report Facebook leads' stages to Meta (`services/metaCrm/stageSync.js`); and **reading pipeline 33 ("6. HOMETIME MONITORING")** — `crm.deal.list` / `crm.deal.get` / `crm.deal.fields` / `crm.status.list`, never a write — for the home-time violation alerts to accounting, woken by a Bitrix robot's webhook (`docs/architecture/home-time-violation-alerts.md`) | best-effort; never blocks the Telegram post, and an unreadable assignee degrades to the shared sending number. A form answer with no Bitrix field is written into the lead's COMMENTS rather than dropped. `POST /api/settings/bitrix/diagnose` reports the whole chain; the webhook URL is a credential and is never returned, only its host |
| **AI: Groq and Gemini** | `GROQ_API_KEY`, `GEMINI_API_KEY` | reports, insights, annotation, group-status classification, driver-profile parsing, home-time intent, translation | **the fallback is per-consumer, not global** — see below |

**There is no single AI stack — check the provider before you touch a consumer.**
`services/groqClient.js` and `services/geminiClient.js` are independent clients,
and each feature picks its own:

- **Groq-first, Gemini fallback** inside the consumer (e.g.
  `translationService.js`, `aiAnnotationService.js` — they catch the Groq error
  and retry on Gemini only if `GEMINI_API_KEY` is set).
- **Groq only**: `aiAnalysisService.js`, `aiInsightsService.js`.
- **Gemini only**: the home-time services, `driverProfileAiParser.js`.
  (`pinnedContext/aiExtraction.js` was here until the pinned-load reading was
  removed on 2026-10-23.)

There used to be a fourth shape — **two-way, order decided at runtime** —
and it had exactly one consumer, which went with the Dispatch Center:
`dispatchParserService.js` tried Gemini first when the extracted text was weak
or came from PDF OCR, otherwise Groq first, with a deterministic parser beneath
both. The text-extraction remnant `extractRateConRawTextFromFile` went with
the pinned-load reading in October 2026. See
[`../architecture/retired-dispatch-center.md`](../architecture/retired-dispatch-center.md)
and [`../architecture/retired-dispatch-eta.md`](../architecture/retired-dispatch-eta.md).

So an AI call is **not** automatically resilient — do not assume a fallback
exists, and do not delete a provider as "redundant". Consumers must degrade or
fail closed — the home-time intent services treat an unavailable model as "no
signal" rather than as a decision.

**AI prompt-injection fencing is a critical invariant.** Driver text is
untrusted and is fenced (`<driver_transcript>` plus sanitizers) before reaching
any model. See `tests/aiTranscriptFence.test.js`. Never remove the fencing.

**Every image sent to a model goes through `services/aiImagePrep.js`.** It
EXIF-rotates, bounds the long edge to 1600px, re-encodes JPEG and strips
metadata — turning a typical 12 MP phone photo from several megabytes into a
couple of hundred KB, which matters because base64 inflates the payload another
third on the way out of Render. The models downsample internally, so recognition
of unit numbers and document text is unaffected (`tests/aiImagePrep.test.js`).
Two rules: it shrinks only the **transient copy sent outbound** — whatever
persisted the original keeps it untouched as evidence — and it **fails open**,
passing PDFs and undecodable buffers straight through so a model never simply
receives nothing. Callers: `homeTimeImportService` and Safety Approvals'
`aiReading` — `dispatchParser/aiRequests.js` went with the Dispatch Center,
`pinnedContext/aiExtraction` with the pinned-load reading, and the Finance
Monitor's `documentReader` with the Finance Monitor (2026-10-23). Do not add a new
`toString('base64')` image path that bypasses it.

### Configuration model

Only **five** environment variables are required (`config/config.js`
`requiredEnv`): `DATABASE_URL`, `JWT_SECRET`, `BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`,
`FACEBOOK_TOKEN_ENCRYPTION_KEY`. **Most other settings carry a hardcoded default
in `config/config.js`** — a deliberate decision so only true secrets live in the
Render environment, and new non-secret config belongs there as a default rather
than as a new required variable.

**But "has a default" is not universal, and the exceptions are deliberate.** The
two bonus Telegram group IDs (`mileageBonusGroupId`, `roadBonusGroupId`) resolve
to `''` on purpose (the driver-raise review's two were removed with it):
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
row wins over env**: `eld_settings`, `ringcentral_settings`, `bitrix_settings`,
`message_group_settings`, `samsara_settings`,
`safety_event_video_settings`. (`bol_pod_forwarding_settings` is still in the
schema but read by nothing since BOL/POD forwarding was removed.)

**`samsara_settings` is read by two processes.** Settings → Samsara is the
single home for the Samsara connection (API key, base URL, enabled), the
safety-event switches and missing-video recovery; the separate
`samsara-integration` poller reads the same row over the shared database and
picks up a change within a minute, so replacing the API key or moving the
recovery delay needs no Render redeploy. Two consequences worth knowing:

- The key cannot use `lib/security/facebookCrypto` — the poller holds neither
  `FACEBOOK_TOKEN_ENCRYPTION_KEY` nor `JWT_SECRET`. It uses the same AES-256-GCM
  envelope with a key derived from a secret both services already hold; see
  `lib/security/sharedIntegrationCrypto.js` for exactly what, why, and what it
  does not protect. `api_key_fingerprint` records which key material wrote a
  value, so a reader that cannot open one falls back to its environment variable
  and says so rather than losing Samsara.
- Every value falls back to the environment **per value**, so the Samsara key
  currently deployed keeps working with nothing entered and nothing migrated.
  A save that does not include a key leaves the stored one alone.

---
