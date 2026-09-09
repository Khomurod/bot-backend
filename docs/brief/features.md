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

### Operational consistency (Needs Attention)

- **The system checks its own facts against each other and files a *finding* when
  they disagree.** `services/operations/consistencyService.js` sweeps every 15
  minutes: it reads ONE snapshot, runs every pure check in
  `services/operations/checks/*.js` over it, and upserts into
  `operational_findings`. All the judgement is in the pure functions; the service
  only does I/O.
- **`operational_findings` generalises `duplicate_unit_reports`**, whose upsert /
  first-seen / auto-resolve shape had been doing this job for one check family
  since the Route Control work. Migration 0016 carries its rows across **with
  their open/resolved state and original `first_seen_at`**, so the fleet's
  existing detection history is not reset. The old table and its service are
  untouched and still running.
- Three lifecycle rules keep the page trustworthy, and each exists to stop a
  specific failure: a recurring condition **updates one row** (46 drivers past
  their road allowance must not file 46 new rows every sweep); a finding a human
  **dismissed with a reason stays dismissed** even while the condition holds
  (re-opening it would overrule the only person who looked); and **auto-resolve
  is scoped to the checks that actually ran to completion**, so a failed check or
  a provider outage can never be mistaken for "the problem went away".
- A **dismissal without a reason is refused by the database**, not the route.
- `home_time.closable_open_cycle` is the high-value one: `classifyOpenCycles`
  sorts every open cycle into evidence **class A** (the group is on the road
  since after this cycle's `home_arrived_at` — `driver_home_status.state_since`
  IS the observed return), **class B** (a later cycle exists, and a `road→home`
  insert can only happen from the road state, so that row's `road_started_at` is
  this return seen from the other side), **class C** (genuinely still home —
  correctly open) or **N**. Only A and B propose a change, and the proposal
  deliberately omits `bonus_usd`, so the repair is payout-neutral. The same
  function will drive the Stage-6 repair batch, so findings and repair agree by
  construction.
- Guarded by `tests/operationsChecks.test.js` and
  `tests/operationalFindingsPg.test.js`.

**Corrections — where the system is allowed to change fleet data.**

- Every action in `services/operations/corrections/actions.js` declares **both
  `apply` and `revert`**. That pairing is the entry requirement: a correction
  whose reversal was never written is one nobody can safely enable.
- Two rules bound what may live in the registry. **The value must already be
  recorded somewhere else** — every action copies a fact the database already
  holds, never an inference. And **nothing is destructive**: every action is an
  UPDATE of a nullable column whose previous value is captured in full. The
  `home_time.ghost_home_status` finding deliberately has **no** action, because
  retiring that row would destroy the only record of where a driver was.
- Each `apply` locks its target **and its evidence** `FOR UPDATE` and
  **re-derives the answer inside the transaction** rather than trusting the
  payload the sweep computed. A finding can be hours old, and the dangerous edit
  is not "someone closed the cycle first" — that one is easy to spot — but
  someone moving the rows the proposal was *measured from*. So
  `home_time.close_cycle` locks every cycle of the group (class-B evidence lives
  in a sibling row) plus the group's `driver_home_status`, re-runs
  `classifyOpenCycles` over them, and writes only if the class is still A or B,
  the return moment is unmoved and the duration still comes out the same.
  Anything else raises `StaleCorrectionError` and the batch skips it. Being
  second to a person is a success, not an error.
  `identity.sync_profile_status` re-confirms `groups.status_source` is still
  `'bot'`, **holding that row `FOR UPDATE`** — it is the evidence, and reading it
  unlocked would let someone take ownership in the window before the commit and
  be overruled anyway.
- **Closing a cycle also resolves `linked_request_id`**, the same ±3-day lookup
  the live `closeHomeStayOnReturn` path does, and for the same reason:
  `homeTimeEfficiencyService.classifyCycle` reads `linked_request_status`, so a
  cycle closed without it files an over-policy stay a human **approved** as
  `non_compliant`. One deliberate difference — the repair requires the match to
  be *unambiguous*. Two decided requests inside the window is a judgement about
  which one authorized the stay, and the registry's own rule says a judgement
  call is not its to make: it stands down and leaves the cycle for a person.
- One transaction does all of it: run the action, write `operational_corrections`
  with the complete before/after images, **mirror into `admin_audit_log` via
  `insertAdminAudit(entry, client)`** — the same transaction, which is what that
  function's `client` argument exists for, and which brings its recursive secret
  redactor along — and mark the finding `applied`. **Revert is the same path in
  reverse**, is itself audited, stamps the original row rather than deleting it,
  and re-opens the finding.
- Three guardrails on auto-apply (`corrections/autoApply.js`): **per-check
  permission, default deny** (`operational_check_settings`, seeded with no rows,
  because "may close home-time cycles" and "may change a driver's status" are
  different decisions); **dry run** unless `apply: true`; and a **per-check cap**
  — a check wanting more than its cap changes *nothing* and files a `serious`
  finding about itself, since wanting to change hundreds of rows usually means
  the check is broken, not the fleet. **The cap is decided by a `COUNT`, never by
  the size of a fetched page**: a `LIMIT` can only ever say "at least this many",
  so at the top of the range (cap 500, 501 eligible) measuring a truncated page
  read as compliant and would have applied 500 corrections instead of refusing.
- The database is the backstop, not just the code:
  `operational_corrections_system_is_auto_only` refuses a system-applied
  correction at any tier but `auto`, and a reversal without an attributed actor
  is refused outright.
- **The page is `admin/src/pages/OperationsPage.jsx`** + `pages/operations/*`
  (hook, pure labels, list card, detail drawer, History and Automation tabs),
  served by `/api/operations`. Three tabs in the order the work happens: what is
  wrong, what has been done about it, and what the system may do by itself —
  automation last, deliberately, because a page that opens on its switches
  invites turning things on before reading what they would do.
  - **Findings are grouped by check.** Forty-six drivers past their road
    allowance is ONE thing to think about; forty-six flat rows is a page nobody
    opens twice.
  - **The drawer leads with evidence, not with a button.** What we think is
    wrong, *why* we think so (the exact recorded values), what would change as
    explicit `field: now → would become` rows, and only then the actions.
  - **A quiet page says why it is quiet.** The summary carries sweep state,
    because "nothing needs attention" and "the sweep stopped three days ago"
    look identical and mean opposite things. Severity tiles render at zero
    rather than vanishing, for the same reason the VideoRecoveryCard's do.
  - **A failed refresh keeps the last good data and puts a banner over it** —
    never a reassuring empty list, which is the exact failure mode
    `server/middleware/failureResponse.js` exists to remove.
  - The History tab is the **first reader `admin_audit_log` has ever had**. A
    reverted correction is shown struck through, not removed.
  - Guarded by `admin/src/pages/operations/{labels,OperationsPage}.test.jsx`.
### AI routing and governance (Admin → Settings → AI)

- **AI is an accelerator, never a dependency.** Twelve consumers already degrade
  to deterministic logic. The master switch being OFF is a supported, tested
  mode — the whole suite passes with every provider disabled — which is the
  enforceable form of that rule.
- **`services/ai/` is ~500 lines and adds ZERO runtime dependencies.** Every
  mechanism either already existed in `groqClient` (model chains, retry-after
  parsing, capped waits, abort timeouts) or is a timestamp comparison. ModelMix
  and ai-fallback were read for their proven shapes; neither is installed.
- **`lib/ai/classify.js` fixes a live defect.** `groqClient.isAuthOrConfigError`
  treats 401/403 as fatal and **aborts the whole chain** — defensible with one
  provider, plainly wrong with several, where it turns one expired credential
  into a total AI outage. Four classes, and the order they are tested in is the
  argument: quota language is checked BEFORE the transient status set, because a
  spent free tier arrives as a 429 and 429 is in that set. A 400/404/422 is OUR
  request being wrong, so it moves on **without cooling anyone** — one stale
  model name must not disable a working provider.
- **`lib/ai/cooldown.js` is the circuit breaker, and it is a timestamp.** A
  rejected credential cools *indefinitely* — a sentinel, not a long timer, since
  no elapsed time makes an expired key work — and clears the moment an
  administrator saves a new one.
- **Two adapters cover everything.** `openai_chat` serves Groq, Cerebras,
  Mistral, OpenRouter and Together, so adding one is a `base_url` and a key in a
  row. Gemini keeps its own adapter and **gains the timeout it has never had**:
  the existing client passes no signal, so a hung connection hangs the caller
  forever, reachable from interactive paths.
- **`enabled` and `cooled_until` are never written by the same code.** `enabled`
  is a person's decision; the cooldown is the system's temporary opinion. The
  router writes only the latter.
- **`/test` proves the CANDIDATE key from the request body**, not the stored
  one, so a typo never becomes a silently dead provider. A rejected key answers
  200 with `ok:false` and a failure *class* — "the key is wrong" and "the free
  tier is spent" look identical in a raw error string.
- Schema hard lines: a cooldown without a reason is refused, and
  `ai_capabilities.may_auto_apply` is `CHECK`ed to FALSE — AI may rank and
  explain a finding, never author or apply a correction. The call log holds **no
  prompts, no completions, no PII**.
- Guarded by `tests/ai{Classify,Cooldown,Router,SettingsRoutes,GovernancePg}.test.js`.

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
