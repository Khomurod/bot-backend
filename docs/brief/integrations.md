<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list. -->

# §6. Integrations and configuration

| Integration | Config source | Used by | Failure behavior |
|---|---|---|---|
| **Telegram** (Telegraf 4) | `BOT_TOKEN`, group IDs in `config/config.js`; IPv4 agent | everything | `safeSend` does 429-aware retries with backoff and rethrows permanent errors (403 / chat not found / deactivated / upgraded) immediately — it does **not** downgrade HTML to plain text; that fallback is feature-local (`dispatchEtaUpdateService.js`). 409 polling conflicts are suppressed, not fatal |
| **Datatruck** (the company TMS, read-only) | `DATATRUCK_API_TOKEN`, `DATATRUCK_COMPANY` | loads/ETA, mileage bonus, BOL/POD forwarding | features degrade to fallbacks (pinned message, chat history) or skip the tick |
| **Samsara + Drive HoS ELD** | admin **Settings** takes precedence over env. The **Samsara** credential lives in `samsara_settings` (Settings → Samsara) and is shared with the poller; Drive HoS keys and the provider switches stay in `eld_settings`. A Samsara key typed on the Live Location tab is written to `samsara_settings` too, so the two screens cannot disagree | `/location`, `/status`, ETA, live map, fuel alerts, Route Control, duplicate-unit check | GPS fallback chain **Samsara → Factor ELD → Leader ELD** with transient retries (`services/liveLocationResolver.js`) |
| **Google Maps** (Routes + Geocoding) | `GOOGLE_MAPS_API_KEY`, Settings → GMaps `enabled` | ETA routing, Route Control geometry, geocoding | off-route warnings stop; destination auto-completion keeps working |
| **Meta / Facebook** | `META_*`, `WEBHOOK_VERIFY_TOKEN`, `FACEBOOK_TOKEN_ENCRYPTION_KEY` | lead capture, Page connect | events are persisted before processing, then retried |
| **RingCentral** | `RC_*` env → shared pair in `ringcentral_settings`; **per-recruiter** creds live on the `recruiters` row — an OAuth refresh token (preferred) or its own JWT, plus an optional custom client pair (`resolveRecruiterRcAuth` picks: `oauth` > `jwt` > `none`) | lead auto-SMS **as the assigned recruiter**, two-way mirroring, recruiter call KPIs | per-recruiter send falls back to the shared number and says so; refresh tokens are renewed daily and a dead grant is flagged `rc_auth_error`; SMS-only fallback when an MMS filter rejects |
| **Bitrix24 CRM** | **Entered in Settings → RingCentral → Bitrix24** and stored in `bitrix_settings` (single row, webhook encrypted); `BITRIX24_*` env vars are the fallback for anything never saved — the DB row wins once set. The field maps stay file/env-based in `config/`. **The assignee must be a NUMERIC user id** — a name there is ignored by Bitrix, so leads go to the webhook owner; the form refuses a name, the mapper warns once, and the card reports an env-supplied name as ignored | dual delivery of every Facebook lead, **and reading back who owns it** (`crm.lead.get` → `ASSIGNED_BY_ID`) to pick the SMS sender | best-effort; never blocks the Telegram post, and an unreadable assignee degrades to the shared sending number. A form answer with no Bitrix field is written into the lead's COMMENTS rather than dropped. `POST /api/settings/bitrix/diagnose` reports the whole chain; the webhook URL is a credential and is never returned, only its host |
| **AI: Groq and Gemini** | `GROQ_API_KEY`, `GEMINI_API_KEY` | reports, insights, annotation, group-status classification, driver-profile parsing, dispatch-document parsing, fuel detection, home-time intent, translation | **the fallback is per-consumer, not global** — see below |
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
- **Gemini only**: fuel-stop detection, the home-time services,
  `driverProfileAiParser.js`, `pinnedContext/aiExtraction.js`.

So an AI call is **not** automatically resilient — do not assume a fallback
exists, and do not delete a provider as "redundant". Consumers must degrade or
fail closed — `services/fuelStop/detection.js` and the home-time intent
services all treat an unavailable model as "no signal" rather than as a
decision.

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
receives nothing. Callers: `server/services/dispatchParser/aiRequests.js`,
`homeTimeImportService`, `pinnedContext/aiExtraction`. Do not add a new
`toString('base64')` image path that bypasses it.

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
row wins over env**: `eld_settings`, `ringcentral_settings`, `bitrix_settings`,
`gmaps_settings`, `message_group_settings`, `samsara_settings`,
`safety_event_video_settings`, `bol_pod_forwarding_settings`.

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
