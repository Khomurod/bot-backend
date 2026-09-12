<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list. -->

# §4. Features and workflows

### Driver communication

All five admin screens below live on ONE page — **Communications**
(`admin/src/pages/CommunicationsPage.jsx`), with tabs Send Message · Surveys ·
Scheduled · History · Edit by Link. They used to be five sidebar entries split
across two parts of the nav (two under Communications, three inside the
collapsible admin block). **Nothing on the server moved with them**: every route
and every API client function is exactly what it was.

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
  `company_drivers` asks `inferDriverType()` (`/company\s+drivers?/i`), the same
  test the rest of the application uses. It used to match the literal string
  `'(COMPANY DRIVER)'`, so every real `(COMPANY DRIVERS)` team title was silently
  dropped from every company-driver broadcast — and nothing anywhere reports a
  group a broadcast decided not to message.
- **Scheduled messages** — one-time or weekly, Central Time (Luxon);
  `schedulerService.js` claims due rows and reuses the broadcast path.
- **Creator panel** — private chat, one allow-listed user ID: pick an audience or
  a single group; any content is delivered **verbatim** via `copyMessage`.
- **History / Edit by Link** (was Bot Messages / Message Manager) — every outbound send is recorded in
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
  `FOR UPDATE SKIP LOCKED` and pushes periodic ETA messages. Configured in
  **Settings → Dispatcher Board**, where the card moved when the Dispatch Center
  was retired ([`retired-dispatch-center.md`](../architecture/retired-dispatch-center.md));
  it is the only UI for those schedules, which is why it outlived the page.
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
  It is also **the writer of `groups.samsara_vehicle_id`**, because resolving a
  group to a vehicle is something it already does in order to compare driver
  names. It writes a link only when the resolution is unambiguous in *both*
  directions — one vehicle for the unit, a driver name that agrees or is absent,
  and no other group claiming that vehicle, **in this scan or already in the
  database** — so a contested unit (unit `001` is on four active groups) links to
  nobody and stays a report. A group whose own driver is unknown counts as a
  mismatch against any *named* vehicle: incomplete profile data must not become
  an authoritative link. A stored link is cleared **only** when another group
  demonstrably takes the vehicle over; a stale link nobody else claims is left
  alone, because clearing on absence of evidence would flap the column every
  fifteen minutes.

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

Moved to **[§4b. Home time](home-time.md)** — the state machine, the three
manager notices, meaning-based request detection, automatic return-to-road
detection and the home-time cycle invariant. Same document, split when this one
passed the 500-line limit.


### Operational consistency, corrections and AI

Moved to **[§4a. The system checking itself, and the AI that helps](self-checking-and-ai.md)** and
**[§4b. The AI routing layer](ai-gateway.md)** — the findings engine, tiered corrections, the AI
routing layer and the provider terms watcher. Same document, split when this
file passed the 500-line limit.

- **A load is only raised as a question when it IS one.** The lifecycle engine
  files a finding when the board and the truck disagree, or when a load has been
  unreadable in one phase for twelve hours — not for every load that is merely
  not high-confidence. The first production pass filed 191 findings out of 235
  loads and buried the fifteen that needed somebody: `heading_to_pickup` is
  medium-confidence **by design** (it is an inference from a truck moving the
  right way, never an observation), so every load in that phase was filing a
  permanent "not enough evidence" for its whole trip.

- **Needs Attention → Identity** (Phase 3-E): coverage tiles (people, active
  driver groups, groups without a person, trucks assigned, unstamped history) and
  the identity backfill — **Preview first, always**; Apply is disabled until a
  preview has been shown and sits on `operations.corrections.apply`. The Driver
  Groups detail modal opens with the driver's permanent identity: every chat and
  every truck they have held, in time, or a plain "not placed yet". See
  `docs/brief/data-model.md` → the person layer.

### Wenze looking after itself

- **When a part of Wenze breaks and then recovers, it says so — and when it was
  only a blip, it says nothing at all.** Every recovery it reports already ran
  silently (RingCentral token refresh, AI provider cooldowns, model retirement,
  outbox backoff); what was missing was the noticing. Three consecutive failures
  before anything is announced, **recovery announced only where the failure
  was**, flapping said once and then silent. Recovery goes to `self_healing`
  saying nothing is needed; a real outage goes to `system_errors` saying what
  does. Nothing probes an external service.
- **When the same automatic correction is undone three times, Wenze proposes
  something about it** — to `ai_learning`, and only ever as a proposal.
  `operational_learning_suggestions` has statuses `proposed`, `accepted`,
  `dismissed` and **no status meaning "applied automatically"**. Accepting
  records that an administrator agrees; the change is then made by hand.
  The same for repeated refusals of Wenze's recruiting drafts: a rising
  `unapproved_figure` count means candidates keep asking about something nobody
  has taught it, which is a gap to fill under Teach Wenze.
- Operations → **What Wenze learned** shows each proposal with the evidence that
  produced it, including the reasons people typed when they reverted. A
  suggestion without its evidence is an opinion.
  `docs/architecture/self-healing-and-learning.md`.

### Driver retention

- **Wenze says when the company is about to lose somebody, while there is still
  time to do something.** Every four hours it scores each active driver from
  facts other features already recorded — weeks past the road allowance, a home
  request that expired unanswered, earned bonus never posted, days sitting
  empty, and what the driver said in their own words
  (`chat_message_annotations`: `quit_signal`, `complaint`, sentiment). Above a
  threshold it posts to the `retention` notification category with **the
  reasons and a suggested action**, and the action is always something the
  company does: ring them, answer the request, pay the bonus, find them a load.
- **A retention signal is something the COMPANY did, or something the driver
  SAID — never an assessment of the driver.** No behaviour score, no
  performance measure, no employment decision. `refuseEmploymentLanguage` in
  `services/retention/watch.js` refuses a notice that strays, and the
  Operations → Retention screen has exactly two endpoints: read the list and
  say "we know". There is deliberately nowhere to record an opinion of a driver.
- **The decision is arithmetic.** With every AI provider switched off, the same
  drivers are flagged for the same reasons; a model only words one sentence, and
  is given counts and reason phrases with no name and no message text.
- Silence is measured against **that driver's own** earlier volume, not an
  absolute — somebody who never texted much is not a risk. Message-derived
  signals are capped at 30 days because `chat_logs` is pruned there, and a
  driver whose messages were never annotated scores NULL rather than neutral.
- Said once; said again only when the score rises by 3 or more, or a week has
  passed. An acknowledgement buys silence until it gets materially worse.
  `driver_retention_assessments`, `docs/architecture/driver-retention.md`.

### Fuel monitor

The fuel team posts a gas-station location into a driver group → a watch row is
recorded → a poller waits until the truck is within `radius_miles` → it replies to
the original message tagging the driver. Detection is cheap-first (most messages
never reach an AI call).

**The risk watch** (`services/fuelStop/riskWatch.js`, every 20 minutes) answers
what that poller cannot: a low tank, a truck that cannot reach the stop it was
given, one that has driven past it, an instruction from last trip, and an
abnormal burn rate. The operational low-fuel threshold is **30%**, which is the
number the business asked for. Every finding goes to the configured operations
chat and **never to a driver group** — an instruction from a rule nobody has
watched running is how a fleet learns to ignore the bot.

**The reachability plan** (`lib/fuel/planning.js`) turns "it cannot get there"
into a sentence with the margin in it, rounded to what a range estimate from a
tank percentage is actually worth — *about 180 miles*, never *182*. It
**deliberately names no alternative station**: Wenze has no database of
truck-accessible stops, prices or opening hours, so a confident suggestion about
where to fuel a truck four hundred miles out would be an invented fact wearing
the clothes of a plan. It says what is wrong, by how much, and leaves the choice
to somebody who can see one. That restraint is the feature, and it is asserted
structurally — the function has no parameter through which a station list could
arrive, and the module imports nothing.

A cannot-reach notice carries its **own** severity (`serious`) rather than the
fuel category's catalogued `warning`, and the numbers the advice was written
from travel with it as the facts its urgency is computed from — so what a notice
says and what it is prioritised by cannot drift apart. See
`docs/architecture/operational-notifications.md`.

### When two features disagree about one driver

`services/operations/contradictionPass.js`, on the consistency timer. Each
feature reads its own table and reaches its own verdict about the same human;
nothing put those side by side, so each was confidently right in its own terms
and the disagreement lived only in the head of whoever read two screens.

**It reports and never resolves.** There is no correct automatic answer to Home
Time saying a driver is at home while the load board has their truck in transit
— not the more recent row, not the more confident feature. Every finding is
filed at tier `warning`, the tier with no apply action at all, and nothing in
the pass writes to any feature's own table.

The two contradictions it can find today:

- **home while working** — Home Time has them at home, the load board has the
  truck moving.
- **quiet but active** — retention has them gone quiet while the fleet shows a
  fuel reading or a safety event this morning. **This is not a retention
  signal; it is a feed that stopped reporting**, and telling those apart is the
  whole reason for holding one picture of a driver in one place.

A third, *two trucks open at once*, stays in the pure module as a guard but is
**not screened for**: `uniq_driver_units_open_person` makes it unrepresentable,
so a fleet-wide scan for it would find nothing for ever.

**Cost.** One set-based query over the fleet per tick; the six-query per-driver
read runs only for what that screen returns, which is normally nothing. Reading
every driver every fifteen minutes would be roughly 63,000 queries a day to
answer a question that is almost always "no". The screen may over-select and
must never under-select — a false candidate costs six queries, a missed one is a
contradiction nobody hears about.

**Coverage travels with every finding**, because three unreadable sources and no
contradictions found is not a clean bill of health, it is a mostly blank page.

### The Groups page

Five views over the same list, and **one function decides which**
(`driverProfileShaping.groupView`), so a chat lands on exactly one tab and the
counts above the tabs cannot disagree with what opening one shows:

| tab | what lands there |
|---|---|
| **All** | every chat |
| **Active Drivers** | a driver chat that is switched on |
| **Inactive Drivers** | a driver chat that is switched off |
| **Company Chats** | `group_type !== 'driver'` — an office or admin room |
| **Needs Review** | Wenze flagged it, a duplicate needs a decision, or an open `identity.*` / `board.*` / `home_time.*` finding names it |

The precedence is the rule. **Company is first**: a chat that is not a driver's
is not an inactive driver, it is a different kind of thing, and showing it among
the drivers is how five admin and feedback rooms ended up typed as drivers with
driver profiles attached. **Review is ahead of active**: "we are not sure what
this row IS" outranks "it is switched on".

**No client-side guess from a title.** An earlier page decided "company" by
looking for the word in the chat name, which disagreed with the server the
moment a title was edited. `group_type` is a stored fact and the only input.

Each row also carries what the Dispatcher Board says about that driver — the
status and truck, or "no longer on the dispatcher board". A board that is
switched off renders nothing rather than a grey box beside every driver, and no
phone number or ETA text reaches this screen: it is a list of chats, and the
board's per-driver detail belongs on the person panel somebody opened
deliberately.

**Retyping a chat is `identity.set_group_type`, approval tier, applied only by
a person.** The check that proposes it reads a TITLE at 65% confidence, and the
consequences are real — BOL/POD routing and broadcasts stop for that chat — so
the finding spells them out and a human clicks. It refuses outright when the
person layer has a driver placed in the chat: that is stronger evidence about
what the room is for than any reading of its name.

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
- **Wenze is taught what it may tell a candidate, and confirms it first.**
  Facebook Leads → **Teach Wenze**: an administrator types a sentence in
  ordinary language ("company driver pay is 77 cents per mile"), Wenze restates
  what it believes should change, and **nothing is in use until they agree**.
  Three kinds — a `fact` it may say, a `boundary` it must never say, a
  `correction` that overrides both. Nothing is ever overwritten: a changed rate
  produces a new row that supersedes the old one, which stays with the dates it
  was true, because "what were we telling candidates in August" gets asked after
  a dispute. `recruiting_knowledge`, `docs/architecture/recruiting-knowledge.md`.
- **Outside working hours, Wenze continues the conversation as the assigned
  recruiter.** A lead that arrives at 9pm on a Friday is answered by the
  candidate within minutes and then hears nothing until Monday. Wenze now
  replies on the same recruiter's number, through the same `sendSmsAsRecruiter`
  — **but only from what has been approved above**, and only when an
  administrator has switched it on. With nothing approved it answers nothing.
  A draft naming a figure no approved statement contains, or promising,
  guaranteeing, approving, waiving, hiring or setting a start date, is
  **refused whole** rather than edited; the candidate then gets one fixed line
  saying a recruiter will follow up, and a human is told which conversation
  needs them. Capped (four replies by default), silent in quiet hours (21:00–08:00),
  and stood down the moment a recruiter replies. Every reply is posted into the
  recruiter's Telegram thread marked as Wenze's, so they read what went out in
  their name before answering on top of it. **No employment decision, ever.**
  Configured at Facebook Leads → Teach Wenze; `recruiting_hours_settings`,
  `recruiting_ai_conversations`, `docs/architecture/recruiting-after-hours.md`.
- **A recruiter's own typed reply is now recorded**, as `outbound_recruiter` on
  the mirror ledger. It used to be sent and forgotten, so the database held the
  opening line and the candidate's answers and nothing in between — anybody
  reading that thread back was reading half a conversation and could not tell.
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
