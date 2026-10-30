<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list. -->

# §4. Features and workflows

### Finding a screen

The admin panel has five sidebar groups — **Drivers · Recruiting ·
Communications · Monitoring · Administration** — with one entry per page (14),
and no collapsed "Admin" drawer: every section needs the same permission, so a
section named after the permission said nothing about what was in it. Settings
is ONE entry; its 14 sections sit under seven groups in the page's own list.
Where each function lives, and why: `docs/redesign/structure.md`.

**Every admin page and every page-level tab has a URL.** The page is the hash
and the tab its second half (`/admin#settings/board`, `#operations/history`),
so a screen can be bookmarked, pasted into a chat, or reached with Back — until
Stage C3 `/admin` was the only URL the panel ever produced, and until October
2026 a tab changed inside a page reached neither the address nor the sidebar
highlight. A tab change replaces the address (Back leaves the page); a page
change adds to it. A hash naming a page that has since moved opens the exact
tab its content went to (`#broadcast` → Messages → Send Message,
`#settings_board` → Settings → Dispatcher Board) and is rewritten in place to
the new address; anything unrecognised opens Driver Groups. List filters stay
out of the address, and so does the one tab bar nested inside a tab (Send
Message's Announcement / Confirmation), which always opens on Announcement.
`admin/src/navigation/pageKeys.js`.

### How the panel looks (October 2026 redesign)

One design language, two themes. Every colour is a token in
`admin/src/styles/01-design-system.css` and pages use `var(--…)` rather than a
literal, so a new screen is readable in both themes for free. The deliberate
exceptions keep a fixed palette: the public displays (`/recruiters`,
`/dispatch`, `/dispatchteam`), Telegram's blue in the message preview, the
Facebook / Indeed brand badges and the map pins. **Light is the default;
dark follows the operating system** until a person picks one with the switch in
the sidebar footer (remembered per browser, applied before first paint). Every
tabbed screen uses the one shared tab bar (`admin/src/components/ui/TabBar.jsx`)
— the page still owns which tab is open; arrow keys move focus and Enter opens.
Tabs that switch sections pass `idPrefix` and wrap the open section in a
`tabpanel`; a bar that only filters one list passes `filter`.
On a phone the sidebar is a drawer behind a sticky top bar. The admin
typography is scoped to the panel (`.app-layout`, `.login-container`) so the
public displays served by the same app keep their own. The redesign changed no
route, request or permission; its few behaviour changes, and what was checked,
are in `docs/redesign/verification.md`.

### Driver communication

All five admin screens below live on ONE page — **Communications**
(`admin/src/pages/CommunicationsPage.jsx`), with tabs Send Message · Surveys ·
Scheduled · History · Edit by Link. They used to be five sidebar entries split
across two parts of the nav (two under Communications, three inside the
collapsible admin block). **Nothing on the server moved with them**: every route
and every API client function is exactly what it was.

- **Surveys / feedback** — **Messages → Surveys → New survey** (a screen only
  since the October 2026 audit; before it the tab was read-only and the routes
  had no caller): the question and 2–10 answer options in English, **Translate**
  fills Russian and Uzbek through `translationService` (both stay editable and
  can be typed by hand when the AI is not configured; an English edit after
  translating is flagged, never re-translated), an optional English-only test
  send to the management group (answers to it are never recorded), then
  **Save** — which does NOT send. `POST /api/questions` refuses anything short
  of the question and every option, non-blank, in all three languages
  (`server/routes/helpers/surveyBodyHelpers.js`). Each card then offers
  **Send** — every ACTIVE driver group, each in its own language, after a
  confirmation that names how many groups (and says when it already went out);
  the result names the groups that could not be reached — and **Close survey**.
  A send that reached at least one group is remembered on the question
  (`last_sent_at`, `last_sent_groups`, migration 0089); a survey from before that
  with answers reads "Sent earlier". **A closed survey can be neither sent
  (409) nor answered**: a driver tapping an old button is told "This survey is
  closed." and nothing is recorded. The insert itself decides (`saveResponse`
  inserts only while the survey is open and only one of ITS options, locking
  the question row against a concurrent Close), so a tap a moment before the
  close cannot slip in after it. Answers are relayed to the management group
  in English. **Answers are multiple-choice only**: `responses`
  stores an `option_id` and has no text column, so a question must have options
  and a driver answers by tapping an inline button. Deduped by a unique index on
  `(driver_id, question_id)`. Free-text driver input reaches the company through
  the separate anonymous-feedback flow, not surveys.
- **Broadcasts** — targeting via `services/broadcastTargetService.js`
  (`all`, `language_groups`, `specific_drivers`, `company_drivers`, `employee`,
  `other_company`, plus an active filter), media via staged Telegram `file_id`s,
  placeholders via `broadcastTemplateService.js`, per-group results in
  `broadcast_deliveries`.
  `company_drivers` asks `inferDriverType()` (any `COMPANY` word — `( COMPANY )` on
  its own counts since October 2026), the same
  test the rest of the application uses. It used to match the literal string
  `'(COMPANY DRIVER)'`, so every real `(COMPANY DRIVERS)` team title was silently
  dropped from every company-driver broadcast — and nothing anywhere reports a
  group a broadcast decided not to message.
- **Scheduled messages** — one-time or weekly, Central Time (Luxon);
  `schedulerService.js` claims due rows and reuses the broadcast path; a claim
  left stuck by a dead process is released, never re-sent (`decideStaleClaim`).
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

- **Group command** `/location` posts the truck's live GPS position
  (`services/liveLocationResolver.js`: Samsara → Factor ELD → Leader ELD).
- **The dispatcher ETA updates, `/load`, `/status` and `/update` were removed**
  (2026-10-23, the owner's decision), together with the pinned-load reading:
  loads come from the Dispatcher Board and Datatruck, never from a pinned
  message or a screenshot. See
  [`retired-dispatch-eta.md`](../architecture/retired-dispatch-eta.md).
- **Live Locations** — authenticated admin map (`liveLocationsService.js`); map
  tile URL is served only to logged-in admins, never baked into the bundle.
- **Board ↔ Bitrix check** (29 October 2026, the owner's request) — every 15
  minutes the Dispatcher Board, **the source of truth**, is compared with
  Bitrix24: active drivers (pipeline 3 "DRIVER RELATION"), their assigned trucks
  (the "Trucks" smart process, Company 001 and Lease 001 kept apart) and their
  stage (HOME/SHOP/VACATION/WORKING). Each difference is asked **one at a time**
  in the Needs-attention group; the owner fixes Bitrix and replies "done", Wenze
  re-reads Bitrix at once and confirms (then asks the next) or says what still
  differs; "skip" brings it back tomorrow. A letter or two (none in a word under
  four letters, one in a word of four or five), a space or the word order in a
  name is the same driver and not asked. Bitrix is only read. Off
  until switched on in Settings → Dispatcher Board. See
  [`board-bitrix-check.md`](../architecture/board-bitrix-check.md).
- **Route Control was removed** (October 2026, the owner's decision): no
  Google Maps route links in driver groups, no off-route warnings, no Settings →
  GMaps. Its tables are still there, read by nothing. See
  [`retired-route-control.md`](../architecture/retired-route-control.md).
- **Duplicate unit check** — every 15 minutes, scans active driver groups for
  duplicate unit numbers and Samsara driver-name mismatches, and stores findings
  in `duplicate_unit_reports`. The open driver-name mismatches and ambiguous
  matches reach a person on **Needs Attention** (`samsara.driver_name_mismatch`,
  `samsara.ambiguous_unit_match`, via `checks/vehicleMatch.js`); the three
  `/api/live-locations/duplicate-reports*` routes that once listed, re-ran and
  resolved them had no screen and were removed (October 2026 audit). It
  **deliberately never messages driver groups.**
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
- **The driver-raise review was removed** (October 2026, the owner's
  decision: the company no longer raises rates, and dispatchers are no longer
  asked). No weekly round, no public `/raise` page (it answers 410), no Driver
  Raises page, no dispatch-team roster rebuilt from the Dispatcher Board, and no
  *Dispatch Rate Review* / *Driver Raise Results* Telegram groups. Its tables are
  still there, read by nothing. See
  [`retired-driver-raise.md`](../architecture/retired-driver-raise.md).
- **Road / extra-week bonus** — posted as **one summary at the road→home
  transition**, never week-by-week. Company drivers only (owner-operators earn
  $0). Claimed atomically per completed leg in `driver_road_history`, with a
  background poller as a retry safety net.

### Finance Monitor (removed)

The Finance Monitor — money-code capture from the finance Telegram group, the
AI reading of its messages and attachments, the attachment reader, the weekly
money-code summary, the Finance page under Operations and Settings → Finance —
was removed on 2026-10-23 at the owner's request. No group is read for money
codes any more. Its six `finance_*` tables, the only money-code record, are kept
until an administrator drops them after a backup. What went, what stayed (the
Telegram file download Safety Approvals uses) and why:
`docs/architecture/retired-finance-monitor.md`.

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
- Needs Attention → **Suggestions** (the "What Wenze learned" tab until October
  2026) shows each proposal with the evidence that
  produced it, including the reasons people typed when they reverted. A
  suggestion without its evidence is an opinion.
  `docs/architecture/self-healing-and-learning.md`.

### Driver retention

- **Wenze says when the company is about to lose somebody, while there is still
  time to do something.** Every four hours it scores each active driver from
  facts other features already recorded — weeks past the road allowance, a home
  request that expired unanswered, earned bonus never posted, days sitting
  empty, and what the driver said in their own words
  (`quit_signal`; AI reads only messages that may be about leaving). Above a
  threshold it posts to the `retention` notification category with **the
  reasons and a suggested action**, and the action is always something the
  company does: ring them, answer the request, pay the bonus, find them a load.
- **A retention signal is something the COMPANY did, or something the driver
  SAID — never an assessment of the driver.** No behaviour score, no
  performance measure, no employment decision. `refuseEmploymentLanguage` in
  `services/retention/watch.js` refuses a notice that strays, and the
  Drivers → Retention screen has exactly two endpoints: read the list and
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

### Fuel (removed)

Fuel-stop reminders, the fuel risk watch, the truck fuel readings and the admin
Fuel Monitor page were removed in October 2026 at the owner's request; a
driver-group message is no longer read for a gas-station address. What went,
what stayed and the tables left behind: `docs/architecture/retired-fuel.md`.

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
  safety event this morning or a load in transit. **This is not a retention
  signal; it is a feed that stopped reporting**, and telling those apart is the
  whole reason for holding one picture of a driver in one place.

A third, *two trucks open at once*, stays in the pure module as a guard but is
**not screened for**: `uniq_driver_units_open_person` makes it unrepresentable,
so a fleet-wide scan for it would find nothing for ever.

**Cost.** One set-based query over the fleet per tick; the five-query per-driver
read runs only for what that screen returns, which is normally nothing. Reading
every driver every fifteen minutes would be roughly 53,000 queries a day to
answer a question that is almost always "no". The screen may over-select and
must never under-select — a false candidate costs five queries, a missed one is a
contradiction nobody hears about. (Six until the fuel section left the driver
context in October 2026.)

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
| **Needs Review** | Wenze flagged it, a duplicate needs a decision, or an open `identity.*` / `home_time.*` finding names it |

The precedence is the rule. **Company is first**: a chat that is not a driver's
is not an inactive driver, it is a different kind of thing, and showing it among
the drivers is how five admin and feedback rooms ended up typed as drivers with
driver profiles attached. **Review is ahead of active**: "we are not sure what
this row IS" outranks "it is switched on".

**No client-side guess from a title.** An earlier page decided "company" by
looking for the word in the chat name, which disagreed with the server the
moment a title was edited. `group_type` is a stored fact and the only input.

Rows no longer carry a Dispatcher Board badge, and the person identity panel
no longer has a board block (both removed October 2026 — the Board is read only
by Home Time now; see
[`dispatcher-board.md`](../architecture/dispatcher-board.md)).

**Retyping a chat is `identity.set_group_type`, approval tier, applied only by
a person.** The check that proposes it reads a TITLE at 65% confidence, and the
consequences are real — broadcasts stop for that chat and its profile stops
being indexed as a driver's — so
the finding spells them out and a human clicks. It refuses outright when the
person layer has a driver placed in the chat: that is stronger evidence about
what the room is for than any reading of its name. **Except a placeholder**: on
10 September 2026 the person layer gave every driver-typed office chat a
"person" named after the chat itself ("HR Personnel", "Employee Feedback"),
which made all seven office chats impossible to retype. A bot-created person
whose name IS the chat's title (or the title without its "(Admin)"), with no
other chat, truck or Telegram account, is ended in the same transaction and
reopened by the revert. A driver's name parsed out of a "WENZE UNIT #" title is
never treated as a placeholder.

### Employee birthdays

On an employee's birthday the bot posts, for each employee, a **card in the
company's template** to the employee group — their photo, full first name and
American name — with the owner's **fixed caption** tagging their Telegram
account. No model writes it (the AI birthday message was removed on
2026-10-23). The staff list, its American names, Telegram accounts and photos
are kept in Birthdays → **Employees** (Users → Company Employees until
October 2026, and before that the always-empty "Dispatchers" filter); names
and dates on the page's first tab, Birthdays. Telegram accounts can be
*suggested* from the accounts the bot has seen — by display name, never by
username — and a suggestion never overwrites one a person typed or confirmed.
Exactly one card per employee per day. See
[`docs/architecture/employee-birthday-cards.md`](../architecture/employee-birthday-cards.md).

### Recruiting and leads

Moved to **[§4c. Recruiting and leads](recruiting.md)** — the Facebook lead
chain, the recruiter-owned SMS sender, after-hours answering, Teach Wenze,
Customer Inquiries and recruiter KPIs. Same document, split when this one ran
out of room under the 500-line limit.


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

### Gross Grand Prix at `/dispatch` and `/dispatchteam`

Office-screen races of this week's gross, counting the loads picked up this
week (Monday–Sunday, Chicago, by PU date) that are not booked or cancelled —
every dispatched load counts in exactly one week, whenever it was created or
delivers (the owner, 16 October 2026). Datatruck's driver board files loads by
DEL date instead, so the totals differ around a weekend. The rule is printed on
the board.
`/dispatchteam` races the dispatch teams by the share of a
$15,000-per-solo / $20,000-per-team-truck target; `/dispatch` races whoever
created the loads, by gross alone, five to a screen. At 4:00 PM Chicago, every
day, each board celebrates its leader for twelve seconds over a 3D car
(`?celebrate` previews it); on `/dispatchteam` only, the company's video kept
on the server follows the car, and a **Test sound** button shows what the
screen can do. **Settings → Gross Grand Prix** shows that video and pauses,
replaces or deletes it (pausing stands down the video only, never the car),
and gives the Windows shortcut command that opens the board full screen with
sound allowed. A screen reloads itself within about a minute
of an admin-panel deploy; on the office screens use the browser's own full
screen (F11, or that shortcut's kiosk mode), because a reload ends the page's. Public, like
`/recruiters`. **The server reads Datatruck with the app's own token and holds
the week in memory; the page never sees a token.** See
[`docs/architecture/gross-race.md`](../architecture/gross-race.md).
