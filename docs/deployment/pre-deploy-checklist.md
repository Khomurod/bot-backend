# Pre-Deploy Checklist — `bot-backend`

> **What this is.** A safety checklist to run **before every deployment** of the
> Wenze operations hub. This is a mission-critical, live trucking system. The
> goal of a deploy is **zero broken existing features**.
>
> **How to read it.** Each item has a plain-English **What/Why** and a
> **How to check**. A non-technical owner can read the left side and understand
> what is being protected; a developer or AI agent follows the right side.
>
> **Golden rule:** if you cannot verify something locally, mark it
> **“needs staging/production verification”** — do **not** guess and do **not**
> mark it done. Never fake a result.

**Legend:** ☐ = to verify · **[AUTO]** = can be checked by an automated
test/command · **[MANUAL]** = needs a human/staging check · **[PROD]** = confirm
after deploy on the live service.

---

## 0. Before you start (change hygiene)

- ☐ **[AUTO]** Working on the correct branch, not straight on `main`.
- ☐ **[MANUAL]** The change is as small as possible; unrelated code was **not**
  refactored.
- ☐ **[MANUAL]** No secrets, tokens, or `.env` files are staged
  (`git status`; `.env` is git-ignored — keep it that way).
- ☐ **[MANUAL]** You read `docs/architecture/module-map.md` for the feature you
  touched, including its "Risks / Do NOT touch yet" notes.

---

## A. General checks

| # | What / Why | How to check |
|---|---|---|
| A1 | **App starts successfully** — the whole system boots. | **[AUTO]** `node --test ... tests/*.test.js` passes; **[PROD]** service reaches "started" in Render logs. |
| A2 | **No crash loop** — it does not restart over and over. | **[PROD]** Render shows one stable instance, not repeated restarts; watch for the circuit-breaker message in logs. |
| A3 | **No missing environment variables.** | **[MANUAL]** `npm run` `check-prod-env` script (`scripts/check-prod-env.js`); compare Render env against `.env.example` and `render.yaml`. |
| A4 | **Database connection works.** | **[AUTO/PROD]** `GET /api/health` returns `{ healthy: true, db: true }`. |
| A5 | **Telegram bot connects.** | **[PROD]** Logs show the bot launched; send a command in the test group (see B). |
| A6 | **Admin panel loads.** | **[AUTO]** admin build succeeds (`npm run build --prefix admin`); **[PROD]** `/admin` returns the SPA. |
| A7 | **Logs show no critical errors.** | **[PROD]** No `[FATAL]`, no `uncaughtException`, no repeated `[LEADS] CIRCUIT BREAKER OPEN`. |
| A8 | **Scheduled jobs still run.** | **[PROD]** After boot, logs show the schedulers starting (dispatch ETA, birthday, mileage bonus, fuel, recruiter sync, etc. — all started from `index.js`). |

---

## B. Telegram bot checks

| # | What / Why | How to check |
|---|---|---|
| B1 | Bot responds in the test group. | **[MANUAL]** Send `/status` or `/location` in a driver test group. |
| B2 | Bot recognizes driver group. | **[MANUAL]** Confirm the group is `active` + `driver` type; unit parsed from title. |
| B3 | **Bot does not duplicate messages.** | **[AUTO]** `tests/safeSend.test.js`, `botSentMessageRegistry.test.js`; **[MANUAL]** one action = one message. |
| B4 | Bot can send management notifications. | **[MANUAL]** Trigger a management-group post; confirm single delivery. |
| B5 | Bot can send driver-facing messages. | **[MANUAL]** Broadcast test to a test group. |
| B6 | Multilingual broadcast works. | **[AUTO]** `translationParser.test.js`, `broadcastTemplateService.test.js`; **[MANUAL]** EN/RU/UZ render. |
| B7 | Group auto-registration works. | **[MANUAL]** Add bot to a fresh group; confirm `upsertGroup` row created/reactivated. |
| B8 | Driver/group mapping works. | **[AUTO]** `driverGroupTitle.test.js`, `driverGroupDirectoryService.test.js`. |

---

## C. Samsara safety checks (external `samsara-integration` service)

> These run against the **separate** Samsara service. See its own
> `docs/deployment/pre-deploy-checklist.md`. Verify here only that this hub still
> shares the `groups` table correctly.

| # | What / Why | How to check |
|---|---|---|
| C1 | Safety event is received. | **[PROD]** Samsara service logs show polled events. |
| C2 | Notification goes to the Samsara Notification group. | **[PROD]** Hardcoded notifications group receives it. |
| C3 | Notification goes to the correct driver group. | **[AUTO]** `samsaraRouting.test.js` (unit + name match); **[MANUAL]** spot-check. |
| C4 | Event **without** immediate video handled. | **[AUTO]** `samsaraBroadcastDelivery.test.js` (text-first). |
| C5 | Event **with later** video handled (backfill). | **[AUTO]** `samsaraVideoBackfill.test.js`. |
| C6 | Event with **no** video does not crash or duplicate. | **[AUTO]** `samsaraVideoRetryDelivery.test.js`. |
| C7 | Video handling is idempotent. | **[AUTO]** `samsaraIdempotentDelivery.test.js`, in-flight de-dupe. |
| C8 | Samsara polling does not cause memory issues. | **[PROD]** `--max-old-space-size=400`; sequential `pollCoordinator`; bounded queues/sets. |
| C9 | Samsara failures are logged but do not crash the hub. | **[MANUAL]** Samsara service is isolated; hub keeps running regardless. |

---

## D. Dispatch checks

| # | What / Why | How to check |
|---|---|---|
| D1 | Unit number parsed from group title. | **[AUTO]** `driverGroupTitle.test.js`. |
| D2 | GPS lookup via Samsara. | **[AUTO]** `samsaraLocationService.test.js`; **[MANUAL]** `/location` in a group. |
| D3 | GPS fallback via Factor ELD. | **[AUTO]** `driveHosEldService.test.js`; **[MANUAL]** with Samsara disabled for a unit. |
| D4 | GPS fallback via Leader ELD. | **[AUTO]** `driveHosEldService.test.js` (Leader company key path). |
| D5 | ETA lookup works. | **[AUTO]** `etaRoutingService.test.js`, `dispatchEtaUpdateService.test.js`. |
| D6 | Datatruck active load lookup works. | **[AUTO]** `datatruckLoadService.test.js`, `datatruckApiService.test.js`. |
| D7 | Driver group result is accurate. | **[AUTO]** `driverStatusLookupService.test.js`; **[MANUAL]** spot-check a known driver. |

---

## E. Recruiting / lead pipeline checks

| # | What / Why | How to check |
|---|---|---|
| E1 | Meta/Facebook webhook receives a test lead. | **[MANUAL]** Meta test event → leads-bot `/webhook`. |
| E2 | **Duplicate lead is not created.** | **[AUTO]** `facebookWebhookService.test.js` (idempotency key). |
| E3 | **Auto-SMS sends once only.** | **[AUTO]** `facebookLeadAutoMessageService.test.js`, `facebookLeadSmsMirrorService.test.js`. |
| E4 | Bitrix24 lead created/updated correctly. | **[AUTO]** `bitrix24Service.test.js`, `bitrix24LeadMapper.test.js`. |
| E5 | RingCentral reply received & matched. | **[AUTO]** `facebookLeadSmsMirrorService.test.js`; **[MANUAL]** reply from a phone. |
| E6 | Two-way reply does not create wrong lead records. | **[AUTO]** mirror table keyed correctly; **[MANUAL]** spot-check. |
| E7 | Recruiter KPI leaderboard works. | **[AUTO]** `recruiterCallSync.test.js`, `recruiterSyncFallback.test.js`; **[PROD]** `/recruiters`. |

---

## F. Driver operations checks

| # | What / Why | How to check |
|---|---|---|
| F1 | Feedback survey works. | **[AUTO]** `anonymousFeedbackHandlers.test.js`; **[MANUAL]** submit an answer. |
| F2 | Broadcast works. | **[AUTO]** `broadcastTargetService.test.js`; **[MANUAL]** test send. |
| F3 | ~~Driver of the Week voting~~ **REMOVED** — feature retired. | **[MANUAL]** Confirm no "Driver Polls" tab in admin and no `/voting` endpoints. |
| F4 | BOL/POD delivery works (idempotent). | **[AUTO]** `datatruckDocumentService.test.js`, `datatruckDocumentHelpers.test.js`. |
| F5 | Fuel-stop reminder works. | **[AUTO]** `fuelStopAlertService.test.js`. |
| F6 | Home-time policy tracking works. | **[AUTO]** `homeTime*.test.js` (service, request, import, status). |
| F7 | Birthday notification works. | **[AUTO]** `birthdayService.test.js`, `employeeBirthdayWishService.test.js`. |

---

## G. Payroll / approval checks

| # | What / Why | How to check |
|---|---|---|
| G1 | Mileage bonus milestone logic works. | **[AUTO]** `mileageBonus.test.js`, `mileageBonusService.test.js`, `mileageBonusHandlers.test.js`. |
| G2 | 75¢ raise approval workflow works. | **[AUTO]** `raiseApproval.test.js`; **[MANUAL]** run one round on staging. |
| G3 | OTP verification works. | **[MANUAL]** Trigger OTP (Gmail/RingCentral channel); confirm code accepted/expiry. |
| G4 | Approval result is logged (audit trail). | **[MANUAL]** Check `raise_round_picks` / audit rows record who decided. |
| G5 | **No duplicate approval messages.** | **[AUTO]** `service_runs` idempotency; **[MANUAL]** re-trigger does not double-send. |
| G6 | **No unauthorized approval is possible.** | **[AUTO]** accounting-only guard in `mileageBonusHandlers`; **[MANUAL]** non-authorized user is rejected. |

---

## H. AI safety checks (invariants — never regress)

| # | What / Why | How to check |
|---|---|---|
| H4 | **Untrusted driver text is fenced** before AI. | **[AUTO]** `aiTranscriptFence.test.js`; fencing in `aiAnalysisService.js` / `aiAnnotationService.js`. |

> **Retired (checks removed):** H1–H3 covered the "Ask-the-Data" feature
> (`aiAskService.js`, `POST /api/ai-ask`, `aiAsk.test.js`), which was fully
> removed. See `docs/architecture/retired-ai-ask-chat-monitor.md`.
| H5 | Groq → Gemini fallback works. | **[AUTO]** `groqClient.test.js`; **[MANUAL]** with Groq key removed, Gemini serves. |
| H6 | If the AI provider fails, the app does not crash. | **[AUTO]** services fall back to plain text / structured data on AI error. |
| H7 | Driver-facing messages are never raw unsafe AI output. | **[AUTO]** response parsers strip fences, bound length; **[MANUAL]** spot-check. |
| H8 | **Structured API data is used before AI/OCR fallback.** | **[MANUAL]** Confirm the feature tries the API/DB path first, AI only when data is unavailable. |

---

## I. Database / data safety checks

| # | What / Why | How to check |
|---|---|---|
| I1 | **Existing tables are not accidentally changed.** | **[MANUAL]** `git diff database/schema.sql` — no `DROP`, no destructive `ALTER`; new columns nullable/defaulted. |
| I2 | Migrations are safe. | **[MANUAL]** `schema.sql` uses `CREATE TABLE IF NOT EXISTS`; additive only. |
| I3 | **Backups exist before a production migration.** | **[MANUAL]** Take/confirm a Postgres backup before any manual migration. |
| I4 | Idempotency ledgers still work. | **[AUTO]** dedupe tests (see module-map ledger list) pass. |
| I5 | Important events are logged. | **[PROD]** Sends recorded in `bot_sent_messages`; errors in logs. |
| I6 | **No sensitive token is printed in logs.** | **[MANUAL]** Grep new log lines for tokens/secrets; none present. |

---

## J. External API failure checks (resilience)

For each dependency, confirm the app **retries safely where appropriate, avoids
duplicates, logs the error, keeps operating, and never silently loses a safety
or lead event.**

| Dependency fails | Expected behavior | How to check |
|---|---|---|
| Telegram | Safe-send wrapper retries transient errors; no duplicate on success. | **[AUTO]** `safeSend.test.js`, `botSentMessageRegistry.test.js`. |
| Samsara | Isolated service; hub unaffected; events retried next poll. | **[AUTO]** `samsaraIdempotentDelivery.test.js` (external repo). |
| Datatruck | API client backs off; document delivery stays retry-eligible, never duplicates. | **[AUTO]** `datatruckApiService.test.js`, `datatruckDocumentService.test.js`. |
| Bitrix24 | Error logged; lead not lost (webhook idempotency preserves it). | **[AUTO]** `bitrix24Service.test.js`. |
| RingCentral | SMS/reply errors logged; no duplicate SMS. | **[AUTO]** `facebookLeadSmsMirrorService.test.js`. |
| Meta webhook sends duplicate data | Dedup by `leadgen:<pageId>:<leadgen_id>`; one lead only. | **[AUTO]** `facebookWebhookService.test.js`. |
| AI provider fails | Groq→Gemini→plain text/structured fallback; no crash. | **[AUTO]** `groqClient.test.js`. |
| Database temporarily fails | Health flips to 503; claim-based jobs retry; pool recovers. | **[AUTO]** `api-surface.test.js` (degraded health). |

---

## K. Deployment checks (run in order)

1. ☐ **[AUTO]** Run all automated tests:
   `node --test --test-concurrency=1 tests/*.test.js` → **all pass**
   (plus `python -m unittest discover -s leads-bot -p "test_*.py"` if the
   leads-bot changed).
2. ☐ **[AUTO]** Lint/typecheck: *none configured in this repo* — mark N/A.
3. ☐ **[AUTO]** Build the admin panel: `npm run build --prefix admin` → success.
4. ☐ **[MANUAL]** Run DB migrations **only if needed** — this app auto-applies
   additive `schema.sql` on boot; take a backup first if anything changed.
5. ☐ **[MANUAL]** Confirm environment variables on Render match
   `render.yaml` / `.env.example`.
6. ☐ **[MANUAL]** Confirm you are deploying the intended **production branch**.
7. ☐ **[MANUAL]** Commit with a clear message.
8. ☐ **[MANUAL]** Push the branch.
9. ☐ **[MANUAL]** Merge **only after** tests + build pass and a review is done.
10. ☐ **[PROD]** Watch logs after deploy for ≥5 minutes — no crash loop, no
    `[FATAL]`, no circuit breaker.
11. ☐ **[PROD]** Confirm the Telegram bot is alive (send a test command).
12. ☐ **[PROD]** Confirm the Samsara service is alive (its `/health`) — it is a
    separate deploy from `samsara-integration`.

---

## Quick automated gate (copy/paste)

```bash
# From bot-backend/ — the fast pre-merge gate:
node --test --test-concurrency=1 tests/*.test.js   # A1, dedupe, AI-safety, resilience
npm run build --prefix admin                        # A6 admin panel builds
# Optional, if leads-bot changed and Python deps are installed:
python -m unittest discover -s leads-bot -p "test_*.py"
```

If all three are green, sections **A1, A6, B3, B6, B8, C3–C7, D1–D7, E2–E7,
F1–F7, G1/G5/G6, H1/H4/H5/H6/H7, I4, J\*** are covered by automation. The
remaining **[MANUAL]** / **[PROD]** items still need a human or staging check —
do not skip them.
