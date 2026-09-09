<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list. -->

# §4. Features and workflows

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
- **A chat id saved in Home-Time settings is checked for REACHABILITY, not just
  shape.** A Telegram group id is negative, and
  `home_time_settings.internal_clarification_group_id` held `5052301861` for a
  chat that is really `-5052301861` ("HR Personnel"). It was well-formed, so it
  saved; it pointed at nothing, so **101 internal alerts failed with "chat not
  found", exhausted the outbox's six attempts, and no staff alert was delivered
  at all — for months.** `PUT /api/home-time/settings` now rejects a value whose
  negation is a group we know, naming it, and — when a Telegram client is
  available — a chat the bot cannot reach or that is not a group. It stays
  deliberately permissive where it cannot prove a value wrong: an id we have
  never captured still saves, because blocking a legitimate destination is its
  own outage. `services/telegramChatIdCheck.js` + `lib/telegram/chatId.js`;
  guarded by `tests/telegramChatIdCheck.test.js` and
  `tests/homeTimeSettingsChatIdRoute.test.js`. Migration 0014 repaired the stored
  values, rewriting one **only** where the negated id is a group already in
  `groups` — never inventing a sign it cannot justify
  (`tests/chatIdSignRepairPg.test.js`).
- **An exhausted durable queue is countable.** `/api/health` reports
  `queues.homeTimeInternalAlerts.exhausted` (5-minute cache). It deliberately
  does **not** affect `healthy` or the status code: Render and the uptime monitor
  read those, and an undeliverable alert queue is an operator's problem, not a
  reason to declare the service down. `tests/healthQueueSignal.test.js`.

### The home-time cycle invariant

**A change of state must open or close a cycle.** `driver_road_history` is the
record of a road leg and the home stay that followed it; `return_to_road_at`
marks the stay closed.

- **`applyStateTransition` owns BOTH halves.** It inserts the cycle on
  `road → home` and closes it on `home → road`. Closing used to be delegated to
  the caller, and that seam is what produced **74 open cycles out of 79** in
  production: two of the four paths that move the flip-flop never made the call.
  A rule every caller must remember is a rule some caller will forget.
- The four paths — a driver-group `Status:` line, the AI-detected status, the
  **admin state flip** (`server/routes/homeTime/trackerRoutes.js`) and the
  **screenshot import** (`services/homeTimeImportService.js`) — now all go
  through it. The last two used to write `driver_home_status` directly.
- **`announce: false`** for the admin and import paths: bookkeeping without
  congratulations. It also *claims* the bonus post on any cycle it records, so
  `roadBonusNotifierService` does not fire months of stale summaries into a live
  group when somebody imports last quarter's screenshot.
- The import also silently **reset the extra-week watermark** on every run,
  because `upsertDriverHomeStatus` defaults `roadBonusWeeksNotified` to 0 and the
  direct call never passed one. Going through the transition fixes that too.
- **`getOpenHomeStay` is `LIMIT 1`**, so once a second cycle opens for a group
  the older one is unreachable by normal operation. That is why class-B evidence
  exists in the consistency check, and why the ~65 already-open cycles need the
  Stage 3 repair rather than just this fix.
- **The ~65 already-open cycles are repaired through the Stage 3 registry**, not
  a script: audited, revertible per row, and payout-neutral (`bonus_usd` is
  computed at insert and never recomputed). `tests/homeTimeRepairPg.test.js`
  seeds the exact production shape — 38 class A, 27 class B, 9 class C, 0 class
  N — against a real PostgreSQL and asserts the repair closes **65 and only 65**.
- **The default `max_auto_per_run` of 50 silently blocks a 65-row repair.** A
  capped check reports `eligible: 0`, which is indistinguishable from "found
  nothing" — so raising the cap is part of the repair, not an afterthought, and
  `npm run operations:preview` prints `capped` loudly with the fix. The cap that
  unblocks a batch is exactly its size (`planForCheck` refuses on `wanted > cap`)
  and the column is `CHECK (max_auto_per_run BETWEEN 1 AND 500)`, so a batch over
  500 says plainly that no cap can unblock it rather than printing an
  instruction that leaves the operator capped anyway.
- `operations:preview` is **dry unless `--apply`, and that includes `--sweep`** —
  a sweep files findings and resolves cleared ones, which is a write to the table
  the Needs Attention page reads. An `--apply` run **exits non-zero** when the cap
  blocked it, a correction failed, or a check module threw, so a runbook cannot
  record a no-op repair as a success.
- Guarded by `tests/homeTimeCycleInvariant.test.js`, which asserts the
  **negative**: after a `home → road` change by any route, no open cycle may
  remain. Nothing asserted that before, which is why it broke.

- **Revert is an undo, not an overwrite.** Each `revert` locks the target and
  restores the before-image only while every field it changed still holds what
  the correction set it to, and only for the columns that correction actually
  recorded — restoring blindly would destroy a later edit, and `?? null` over a
  column an older correction never captured would turn silence into a deletion.
- Guarded by `tests/operationalCorrectionsPg.test.js`,
  `tests/operationalCorrectionEvidencePg.test.js` (the evidence must still hold
  at apply time; revert refuses over a newer edit; the group row is really
  locked) and `tests/operationalAutoApplyCap.test.js` (the cap at its boundary,
  no database needed).

- Home-time **requests** from drivers get Approve / Do-Not-Approve buttons gated
  on the approver allow-list (see the authorization note in §5 — usernames by
  default, numeric IDs once configured).
- **Every home-time date is a `America/Chicago` calendar date.** The state
  machine, the date resolver, the clarification flow and every AI prompt all
  reason in Central; a UTC instant must be zoned before it becomes a date.
  `homeTimeRequestService.js` used the process default (UTC on Render), so a
  driver arriving home after 19:00 Central had TOMORROW recorded as their home
  start — the window and the bonus math that reads it were a day out. Guarded by
  `tests/homeTimeCentralDates.test.js`, which pins the instant rather than
  trusting the clock.

### Operational consistency, corrections and AI

Moved to **[§4a. The system checking itself, and the AI that helps](self-checking-and-ai.md)** — the findings engine, tiered corrections, the AI
routing layer and the provider terms watcher. Same document, split when this
file passed the 500-line limit.

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
  key `leadgen:<pageId>:<leadgen_id>`) → `facebookLeadEventProcessor.js`
  fetches the lead via Graph → formats → posts to the leads Telegram group →
  creates a Bitrix24 CRM lead (best-effort; CRM failure never blocks the
  Telegram post) → fires auto-SMS **from the assigned recruiter's number** →
  mirrors SMS replies two-way.
- **The lead's text comes from whoever Bitrix24 assigned it to.** Bitrix assigns
  asynchronously, so `facebookLeadSmsSender.js` re-reads `crm.lead.get` on a
  bounded poll (the *assignee wait* setting, default 25s at 5s intervals) —
  **and follows a lead into the deal it was converted into**, because in this
  Simple-CRM portal the round-robin that picks a recruiter fires on the DEAL
  while the lead keeps the webhook owner forever (see
  `docs/architecture/recruiter-sms-sender.md`),
  matches `ASSIGNED_BY_ID` to `recruiters.bitrix_user_id`, and sends with that
  recruiter's own RingCentral credentials. **RingCentral refuses an SMS whose
  `from` is another extension's number** — no token, super-admin included, can
  send on someone's behalf — which is why per-recruiter credentials exist at
  all. It also refuses one that is not **E.164**, and recruiter numbers are
  stored as an admin typed them, so every send goes through
  `lib/phone/e164.js`; a rejection is then checked against what that extension
  really owns instead of being reported as an opaque `MSG-245`. Any gap (nobody
  mapped, no assignee yet, unmapped assignee, broken credentials, an unusable
  stored number, a number not on the extension or not SMS-capable, a rejected
  send) falls back to the shared number `RC_FROM_NUMBER`; **a lead is never left
  un-texted**, every fallback an operator could fix is stated in the Telegram
  thread, and the reason is stored on the mirror row (`fallback_reason`) so it
  can be queried rather than only read.
- **The assigned recruiter chooses the WORDS too, when they have written any.**
  Facebook Leads → Auto-Reply Setup has a **Recruiter messages** section listing
  every active recruiter (Sofia, Kimberly, Jaime, and anyone added later — it is
  driven by the `recruiters` table, not a list in code). One optional template
  each, deliberately not a second scheduling engine: when the assigned recruiter
  has a non-blank one it is used, otherwise the existing global time-window
  rules and the outside-hours fallback decide exactly as before. `{rep_name}`
  renders as the recruiter who is actually texting, falling back to the settings
  rep name when the lead goes out on the shared number. The Bitrix assignee is
  therefore resolved BEFORE the template is picked — one bounded poll per lead,
  not two — and the same resolution is what sends. A blank template deletes the
  row, so "no custom message" has exactly one representation, and a database
  failure reading it silently falls back rather than costing a lead its text.
  `facebook_lead_recruiter_messages`, guarded by
  `tests/facebookLeadRecruiterMessages.test.js`,
  `tests/facebookLeadRecruiterFlow.test.js` and
  `tests/facebookLeadRecruiterMessagesPg.test.js`.
- **A lead that has already been texted is never texted again.**
  `leads.sms_from_number` is the record of it, checked before every send, which
  closes the admin retry button and the at-least-once crash window alike — and
  makes every lead processed before per-recruiter sending immune to a resend.
- **The Bitrix mapping can be done from the panel, not by hand.** Settings →
  RingCentral → Bitrix24 → **Match recruiters to Bitrix users** reads the
  portal's user directory (`user.get`, so the inbound webhook needs the `user`
  scope) and maps recruiters to Bitrix users by phone or full name. It applies
  only strong, unambiguous matches; a first-name-only guess is proposed for
  confirmation, an existing mapping is never overwritten, and previewing is a
  separate call from applying. Details and the refusal rules:
  `docs/architecture/recruiter-sms-bitrix.md`.
- **Recruiters attach their own number themselves.** An admin mints a link
  (Settings → RingCentral, or `POST /api/recruiters/connect-link`); the
  recruiter opens `/ringcentral/connect/:token`, signs in to RingCentral, and
  the app stores an OAuth refresh token plus the extension identity it read
  back. No secret changes hands, and the sending number cannot be typed wrong.
  The older path — an admin pasting that recruiter's JWT — still works and is
  used when there is no login.
- **Self-serve Page connect**: `/connect` in a leads group starts a
  session-token-gated OAuth flow; Page tokens are encrypted
  (`lib/security/facebookCrypto.js`).
- **Indeed leads** arrive from a Gmail Apps Script
  (`docs/gmail-indeed-apps-script.gs`) to `/api/internal/indeed/lead`.
- **Recruiter KPIs**: RingCentral call logs sync into `ringcentral_calls`. The
  targets are configurable defaults (`ringcentral_settings`): 2h30m of real talk
  time per day, 150 outbound calls/day, and calls shorter than 30s do not count
  as valuable. The score weights talk time 70% / outbound 30%. Public leaderboard
  at `/recruiters` exposes names and KPI numbers only — **never phone numbers**.

### Presenter remote at `/remote`

`GET /remote` serves `server/public/remote.html` plus its three assets: a phone
remote for the **Wenzel Weekly Report** deck, which is a standalone HTML file
**not** hosted here.

**It does not talk to this server at all.** The deck can run from a laptop's
file system, so there is no shared server to relay through: the phone and the
deck meet on a **public MQTT broker over WebSocket**. This server only serves
the page. There is no session, no server-side state and no database row.

**The protocol is fixed by the presentation file.** Both halves must agree
exactly or the phone and the laptop never see each other:

- brokers, tried in order: `wss://broker.emqx.io:8084/mqtt`,
  `wss://broker.hivemq.com:8884/mqtt`, `wss://test.mosquitto.org:8081/mqtt`
  (subprotocol `mqtt`, QoS 0, keepalive 30);
- pairing is the **4-digit code the deck displays**, encoded in a QR as
  `<origin>/remote#c=<CODE>`;
- the phone **publishes** `wzl/rc/<CODE>/cmd`
  (`{type:'cmd',action:'hello|ping|next|prev|first|last|goto|fullscreen|minimize|bye',value?,at}`,
  `hello` on connect and `ping` every 7s) and **subscribes**
  `wzl/rc/<CODE>/state` (`{type:'state',index,total,title,fullscreen,presenting}`,
  or `{type:'bye'}` when the deck closes). The first `state` is the pairing
  signal.

`mqttLite()` in `server/public/remote-mqtt.js` is a hand-written MQTT 3.1.1
client, which is why `tests/remoteMqttLite.test.js` slices it out of that file
and asserts the actual bytes against the spec: a stray packet id at QoS 0 is not
a visible bug, it is a broker dropping the link while someone presents.

**A public broker carries these messages**, so treat the code as the only
secret and keep the surface exactly this dull: the page reaches no API on this
server, reads no company data, and the worst an uninvited listener can do is
change which slide is on a projector. Do not add anything to this page that
touches business data.

The page and its assets are served through an **explicit allow-list** in
`server/routes/remoteRoutes.js`, not `express.static` — the page was one
self-contained file until it passed the 500-line limit, and the split must not
turn one exposed file into an exposed directory.
