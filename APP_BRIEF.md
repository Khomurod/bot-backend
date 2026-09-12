# APP BRIEF — Wenze Trucking Operations Hub (`bot-backend`)

**This is the central brief for this application. Read it before any task, then
verify the specific parts you touch against the current source.** It is written
so an AI agent can build an accurate mental model in one read. It is deliberately
not exhaustive: it explains *what exists, why, and what must not break*, and
points at the code that holds the detail.

**This file holds what is worth reading every time**: the purpose, the
deployment topology, who uses it, the "must not break" list (§9), the testing
expectations and the file map. **The per-area sections (§4-§8, §10) are in
`docs/brief/`** — indexed below, numbering unchanged.

Companion documents: `CLAUDE.md` (mandatory working rules and per-feature
invariants — read it too), `README.md` (setup/endpoint reference),
`docs/` (deep dives, database reference, archived-feature records).

*Every claim below was verified against the code on **2026-09-07**. If you are
reading this much later, treat the specifics as likely-but-unconfirmed and
re-check what your task depends on — then update the date when you do.*

**How to read it:** §1–§3 (purpose, topology, users) and **§9 (what must not
break)** are worth reading every time — they are short and they are where the
expensive mistakes live, and they are all in this file. Then open the
`docs/brief/` part covering your task. §10 lists the traps, retired features
and stale docs; §12 is the file map.

---

## ⚠️ PERMANENT RULE — This brief is a living document

**Keeping this brief true is part of every task, not a separate chore.**
**"This brief" means this file AND `docs/brief/*` — they are one document, split
only because it outgrew the repository's 500-line file limit.**

1. **Before changing anything**, read the relevant sections here, then verify
   them against the current code. This brief can drift; the source is the truth.
   If you find drift, fix the brief as part of your task.
2. **After completing any** feature, bug fix, adjustment, removal, behavioral
   change, integration change, workflow change, permission change, or schema
   change — **re-read this brief** and ask: *does it still describe the
   application accurately?*
3. **If your work changed anything described here, update that part in the same
   task.** If you introduced an important behavior, rule, dependency,
   integration, exception, or decision, add it where it belongs. If something
   described here was removed or is no longer true, correct or delete it.
4. **A task is NOT complete while this brief says one thing and the application
   does another.** Treat a stale brief exactly like a failing test.
5. **Keep it useful.** Do not add minor implementation details, line numbers,
   function signatures, or anything that will rot without adding understanding.
   Add a fact here only if a future agent would make a mistake without it.

The same applies to the per-feature invariants in `CLAUDE.md` — if you change a
behavior it guards, update it there too.

---
## 1. App purpose

A **trucking operations and driver-communication platform** for **Wenze
Investments**, a US trucking company. It is the company's internal operations
hub, and almost everything it does reduces to one of two actions:

- **send/receive Telegram messages to and from driver and staff groups**, or
- **read/write the shared PostgreSQL database.**

Follow those two threads and you will find any feature.

Business problems it solves:

- Communicate with drivers at scale, in their own language (EN/RU/UZ), through
  the Telegram groups they already live in.
- Give dispatch real-time truck location, load and ETA information.
- Automate recurring operations work: bonuses, raises, home-time, fuel stops,
  document forwarding, off-route warnings, birthday wishes.
- Capture and convert recruiting leads (Facebook/Meta, Indeed) and measure
  recruiter performance.

---
## 2. Deployment topology and processes

`render.yaml` defines two Render services in this repo; a third lives elsewhere.

| Service | Repo | What it is |
|---|---|---|
| `driver-feedback-bot` | this repo | `index.js` — the whole Node app: Telegram bot + Express API + admin SPA + all background jobs |
| `facebook-leads-engine` | this repo (`leads-bot/`) | Python FastAPI lead worker. In the main deployment `index.js` **spawns it as a child process**; it can also run standalone |
| Samsara safety poller | **separate repo** `Khomurod/samsara-integration` | Polls Samsara safety events → dashcam alerts to Telegram |
| Dispatcher Board | **not a service of ours** — an external Google Apps Script web app over the dispatchers' spreadsheet | Read-only, polled. **The authority on a driver's current assignment**; Wenze stays the authority on who a person permanently is. Off until a URL and token are saved in Settings |

The three cooperate in **two different ways** — do not confuse them:

- **Node hub ↔ Samsara service: shared PostgreSQL only.** Same `DATABASE_URL`,
  no in-process link and no HTTP link between them. The Samsara service reads
  `groups` for driver-group routing, the safety-event video/music settings and
  the `samsara_settings` row this repo manages, and writes
  `safety_event_video_jobs` and `samsara_video_recovery_jobs`.
  **That table IS the configuration channel.** Settings → Samsara is where the
  Samsara API key, missing-video recovery and its delays are set; the poller
  picks them up within a minute. Do not add an HTTP link between the two
  services to exchange settings — the shared database already solves it, and a
  second channel is a second thing to get out of step.
- **Node hub ↔ Python leads worker: internal HTTP only.** The worker has **no
  database access whatsoever** — no Postgres driver in
  `leads-bot/requirements.txt`, no `DATABASE_URL` (and `render.yaml` does not
  give it one). It calls the hub at `LOCAL_API_BASE_URL` with
  `LEADS_INTERNAL_SHARED_SECRET`, and the hub proxies `/webhook` + `/rc-webhook`
  to it. **All lead persistence happens on the Node side.**

Hard constraints of this deployment:

- **Memory-constrained.** The Node process runs with `--max-old-space-size=256`
  on a 512MB instance, `MALLOC_ARENA_MAX=2`, and a Postgres pool of `max=5`.
  Avoid buffering large files, unbounded caches, and new always-on intervals.
  `services/memoryWatchdog.js` can log pressure but is **off unless
  `MEMORY_WATCHDOG_ENABLED='true'`**.
- **The Samsara poller was moved out of this process on purpose** — it caused
  OOM kills. **Do not re-add it here.** The live-GPS lookup that remains in this
  app is a different, much smaller thing and must keep working. See
  `docs/architecture/samsara-separation.md`.
- **All Telegram traffic is pinned to IPv4** via `services/telegramAgent.js`.
  The host's IPv6 path to `api.telegram.org` black-holes multi-packet upload
  bodies. **Do not remove that agent.**
- The Python child is supervised with exponential-backoff restart and a
  **circuit breaker** (5 crashes in 3 minutes → stop restarting; exit code 78 =
  permanent config error, never restarted).
- `main` auto-deploys to Render. A push opens and merges nothing by itself —
  the agent opens the PR, the repository owner merges it — but the owner may
  merge at any moment, so **review the complete diff BEFORE pushing**
  (`CLAUDE.md`).

### The Telegram bots

| Bot | Token env | Role | Owner |
|---|---|---|---|
| Wenze Support / feedback bot | `BOT_TOKEN` | Main bot: feedback, broadcasts, dispatch commands, Route Control, home time, bonuses, creator panel | this repo, `bot/` |
| Wenze lead bot | `TELEGRAM_BOT_TOKEN` | Facebook/Indeed leads, auto-SMS, RingCentral replies | `leads-bot/` + `services/leadsTelegramClient.js` |
| Samsara notification bot | `SAMSARA_BOT_TOKEN` (in the other repo) | Dashcam safety alerts | `samsara-integration` |

- **Only long-polling must be exclusive** — a token may be *sent* on from
  anywhere, but only one process may `getUpdates` it. Two pollers on one token
  produce a permanent Telegram 409 conflict loop, so
  `assertDistinctTelegramPollingTokens()` in `index.js` refuses to boot if
  `BOT_TOKEN === TELEGRAM_BOT_TOKEN`.
- Consequently: the **Python worker polls** `TELEGRAM_BOT_TOKEN` while Node only
  *sends* on it (`services/leadsTelegramClient.js`), and the **Samsara service
  sends** on the hub's `BOT_TOKEN` (to post into driver groups) while only the
  hub polls it. Both are safe; adding a second poller anywhere is not.
- `@datatruck_driver_bot` is a **third-party** bot ours only reacts to
  (`bot/datatruckPeerHandlers.js`).

---
## 3. Main users

| User type | How they use it |
|---|---|
| **Drivers** | Their Telegram driver group is the whole interface: answer surveys, post `Status: Home/Ready/Rolling`, request home time, receive broadcasts, bonuses, route/off-route warnings, BOL/POD documents, fuel reminders. Also anonymous feedback in the bot's private chat. |
| **Dispatchers** | `/load`, `/location`, `/status`, `/update` inside driver groups; assign Google Maps routes (Route Control) by pasting a directions link; receive automatic ETA updates; submit their team's weekly driver-raise picks through the public raise link. |
| **Admins / office staff** | The admin SPA at `/admin`: broadcasts, surveys, groups, leads, live map, home time, fuel, mileage bonuses, raises, recruiter KPIs, settings. |
| **Accounting** | Mileage-bonus Paid/Rejected buttons in Telegram (allow-listed accounting users — see §5); the driver-raise results group. |
| **Recruiters** | Measured, not users: RingCentral call logs feed KPIs and the public `/recruiters` leaderboard. |
| **The owner ("creator")** | A Telegram-only messaging panel in the bot's private chat, gated on one numeric user ID (`CREATOR_USER_ID` in `bot/creatorMessageManager.js`). Also **steers Wenze from the notifications group**: it asks one plain question per open finding it could fix but has not been permitted to, and a reply — *yes*, *no* and why, or *later* — applies, closes or postpones it. Only accounts on the `control_operators` allow-list are obeyed. |

---
## The rest of the brief

The sections below moved into `docs/brief/` when this file passed the
repository's 500-line limit. **Nothing was dropped** — the numbering is
unchanged, so a reference to "§7" still means the same section.

| Section | Read it when |
|---|---|
| [§4. Features and workflows](docs/brief/features.md) | You are touching any feature: driver comms, dispatch, payroll-adjacent flows, fuel, recruiting, the presenter remote |
| [§4b. Home time](docs/brief/home-time.md) | You are touching home time: the home/road state machine, the three manager notices, request detection, automatic return-to-road detection, the cycle invariant |
| [§4a. The system checking itself, and the AI that helps](docs/brief/self-checking-and-ai.md) | Operational findings, tiered corrections, the audit trail |
| [§4b. The AI routing layer, and what AI is allowed to decide](docs/brief/ai-gateway.md) | The provider roster, per-responsibility switches, what a model may and may not say |
| [§4c. The AI provider terms watcher](docs/brief/ai-terms-watcher.md) | You are touching the provider terms watcher: its schedule, its diffing, or what may pause a provider |
| [§5. Permissions and access rules](docs/brief/permissions.md) | Auth, roles, permissions, or any route that is *not* behind the admin JWT |
| [§6. Integrations and configuration](docs/brief/integrations.md) | Telegram, Datatruck, Samsara/ELD, Google Maps, Meta, RingCentral, Bitrix, the AI providers, or where a setting lives |
| [§7. Automatic and background behavior](docs/brief/background-jobs.md) | Anything on a timer, the database transfer budget, browser polling, or an idempotency ledger |
| [§7a. The rules every background job obeys](docs/brief/background-job-rules.md) | Whether a worker actually ran, the shared fleet snapshot, data retention, and why nothing is heard until a notification destination is set |
| [§8. Data model and cross-feature relationships](docs/brief/data-model.md) | Schema, migrations, `groups`, or what else a table change touches |
| [§9a. Code-structure rules](docs/brief/code-structure.md) | The 500-line cap, `lint:undef` / `lint:imports`, the façade rule, one-way dependencies |
| [§10. Known limitations, retired features and intentional exceptions](docs/brief/limitations.md) | Something looks wrong, missing or stale — check here before "fixing" it |
| [§11. Testing and operational expectations](docs/brief/testing.md) | Which commands to run, the verified test baseline, the test endpoints, the operational safety rules |

---

## 9. Decisions and behavior that must be preserved

The full per-feature invariants, with the tests that guard each one, live in
`docs/architecture/route-control.md`; `CLAUDE.md` links to them and holds the
repository-wide working rules. The highest-consequence items:

1. **Signed-URL media transport.** Route Control screenshots reach Telegram as
   short-lived HMAC-signed HTTPS URLs
   (`/api/route-screenshot-media/:id`) — never as raw
   `Buffer`/multipart uploads from Render. The direct-upload path repeatedly
   stalled in production. Signed URLs and query strings are never logged.
   Existing text-only messages are converted **in place** with
   `editMessageMedia`, never replaced with a new post.
   BOL/POD forwarding follows the same rule for the same reason plus bandwidth:
   `datatruckDocumentService` passes the Datatruck URL to `Input.fromURL(url)`,
   which in Telegraf 4.x is *literally* `url.toString()` — a plain string form
   field, so **Telegram's servers** fetch the file and the bytes never enter this
   process. `Input.fromURLStream(url, filename)` is the near-identical-looking
   trap: it returns `{url, filename}`, which makes Telegraf fetch the file itself
   and pipe it through Render. Never swap it in. The download-and-upload fallback
   (over Telegram's ~20MB URL limit, expired presigned links, URLs needing the
   Datatruck token) must stay — delivery reliability wins there.
   Guarded by `tests/bolPodDirectFetch.test.js`.
2. **AI transcript fencing** stays (§6).
3. **IPv4 Telegram agent** stays (§2).
4. **The webhook raw-body proxy must stay mounted before `express.json()`** or
    Meta signature verification breaks.
5. **Auth hardening stays**: HS256 pin, login rate limit, shared-secret guards,
    the loopback guard on `/api/dat-ui/inspect`, and the last-super-admin
    protection (`tests/authMiddleware.test.js`,
    `tests/adminUserGuards.test.js`). The 404-not-403 rule for out-of-scope
    accounts went with the Trailer Manager scoping that was its only user —
    `admin.full_access` is now the single gate (§5).
6. **Handler order in `bot/bot.js` is behavior.** Feature-specific
    `bot.action(...)` handlers must stay registered before the survey/broadcast
    `callback_query` catch-all, which must remain last. Middleware `next()`
    chains are load-bearing.
7. **Config validation stays at the startup boundary**, not at import time.
8. **Do not re-add the Samsara poller to this process** (§2).
9. **A failure is never rendered as empty data.** A read endpoint that cannot
    reach the database must say so — status 503 with a `code`
    (`DB_UNAVAILABLE` / `DB_TIMEOUT` / `DB_QUOTA` / `DB_PERMISSION`) — never
    answer `200 { states: [] }`. Several endpoints used to do exactly that, so
    an outage or an exhausted transfer allowance was indistinguishable from a
    company that owns no assets — on the same screens someone uses to decide
    something is unaccounted for. The classification lives in
    `lib/database/failureClassification.js` (attached at the query boundary by
    `database/pool.js`), the response shaping in
    `server/middleware/failureResponse.js`, and the wording in
    `admin/src/utils/pageFailure.js`. An ordinary SQL error — a unique violation,
    a typo — must NOT be classified as a database outage, or the warning stops
    meaning anything. Guarded by `tests/databaseFailureClassification.test.js`,
    `tests/apiFailureResponse.test.js`.
10. **One broken admin section must not break the others.** Every lazy page is
    wrapped in `PageErrorBoundary`, keyed on the section, so a throw is
    contained and navigating away really renders the next section. A single
    latching boundary once made one page's `ReferenceError` display as "Could
    not load this page" for every section opened afterwards — the whole panel
    looked dead when one page was. Guarded by
    `admin/src/components/PageErrorBoundary.test.jsx`.
11. **An SMS is sent with the credentials of the number it claims to come
    from, and `from` is always E.164.** RingCentral rejects a send whose `from`
    is not on the token's own extension — a super-admin token cannot send on a
    colleague's behalf — so `sendSmsAsRecruiter()` always pairs the recruiter's
    own credential with the recruiter's own number, and
    `services/ringCentralOAuthService.js` is the only place either credential
    shape becomes a token. Never "fix" a rejected send by swapping in the shared
    token: it authenticates and still fails, and the fallback that follows is
    the shared NUMBER, not a shared token behind someone else's number.
    **The second half was a live bug for the feature's first weeks:**
    `recruiters.phone_number` stores whatever an admin typed, and handing
    `(470) 480-4679` to RingCentral answers `MSG-245 … Cannot find the phone
    number which belongs to user` — which reads like broken auth and is not. All
    sending goes through `lib/phone/e164.js` `toE164()`; `phoneKey()` beside it
    is for COMPARING only and is not sendable. A `from` rejection is then
    checked against what the extension really owns rather than reported as an
    opaque provider error. Guarded by `tests/ringCentralSmsSender.test.js` and
    `tests/phoneE164.test.js`.
    - **A lead that already has `sms_from_number` is never texted again.** That
      column is the record of "this person has heard from us", so the guard in
      `facebookLeadEventProcessor` closes the admin retry button, the
      at-least-once crash window, and anything added later — and makes every
      pre-feature lead structurally immune to a resend. A failed lookup opens
      the guard: "cannot prove it was sent" must not become "do not send".
    - **The AutoMessage notice uses the group id AS STORED.** Rewriting it to
      the `-100` supergroup form unconditionally made Telegram answer
      `chat not found`, which threw before the mirror insert — costing every
      lead its `outbound_auto` row and, with it, the anchor a reply threads
      onto. Convert only on a retryable answer (`sendToChatIdWithFallback`).
    - **`rc_extension_id` must be populated for every credentialed recruiter,**
      not just those who signed in through OAuth, or the inbound-SMS
      subscription cannot watch their number and their drivers' replies reach
      nobody while their outbound texts work fine.
12. **A lead is never left un-texted, and a silent fallback is a bug.** Every
    way the assigned sender can be unavailable — nobody mapped, no assignee
    yet, an unmapped assignee, expired credentials, a rejected send, a database
    hiccup — falls back to `RC_FROM_NUMBER` rather than dropping the driver's
    text, and `facebookLeadSmsSender.js` returns a `fallbackNote` for every one
    an operator could fix, which the lead's Telegram thread prints. Sender
    resolution therefore never throws: by the time it runs, the lead is already
    in Telegram and in the CRM, and an exception would cost the text and
    re-run the whole event. Guarded by `tests/facebookLeadSmsSender.test.js`
    and `tests/facebookLeadEventProcessor.test.js`.
13. **A rotated RingCentral refresh token must be stored before it is used,
    refreshed one-at-a-time per recruiter, and dropped from the cache when the
    login changes.** A refresh grant issues a NEW refresh token and kills the
    old one, which makes three things mandatory rather than tidy: persisting
    the rotation (dropping it works once, then locks the recruiter out ~7 days
    later with their leads silently going out from the shared number);
    **serializing** the grant per recruiter, or two concurrent callers spend
    the same token and the loser's `invalid_grant` flags a healthy recruiter as
    needing to re-connect (the call-log sync and the refresh job both start at
    boot); and **invalidating** the access-token cache on a real
    re-authorization, or a recruiter who reconnects to fix a wrong-account
    sign-in keeps sending with the old account's token. The cache is keyed by
    recruiter — not by the credential — because callers hold rows loaded before
    the rotation, which is exactly why the invalidation has to be explicit.
    `ringCentralTokenRefreshService` renews every stored login daily so a
    recruiter who goes a week without a lead does not expire from disuse.
    Guarded by `tests/ringCentralOAuthService.test.js`,
    `tests/ringCentralConnectService.test.js` and
    `tests/ringCentralTokenRefresh.test.js`.

14. **A safety alert is never delayed for video, and a missing clip is
    recovered durably.** The alert goes out immediately, text-only when the
    dashcam clip has not uploaded; the recovery is a row in
    `samsara_video_recovery_jobs`, worked by the Samsara service. Three things
    about it must not be undone: the wait is **durable** (it was an in-memory
    `setTimeout`, so a redeploy inside the window silently dropped every pending
    video while the delivered text alert made everything look fine); the
    retrieval window is **never zero-length** (both paths built it as
    `start = event.startMs || event.time`, `end = event.endMs || event.time`, so
    a single-instant event asked Samsara for footage from T to T, which it
    cannot produce); and the **retrieval id is persisted**, so a retry polls the
    request already running instead of queueing a second one for the same
    seconds of video. `samsara_event_id` is UNIQUE and the insert is
    `ON CONFLICT DO NOTHING`, which is what makes a re-delivered event add
    nothing. Telegram's part is unchanged and still the safe order — send the
    video with the original caption, delete the text ONLY on success — and the
    destinations a send missed stay on the job so a retry never posts a second
    video where one already landed. The schema and the admin API live here
    (migration 0013, `database/samsaraSettings.js`,
    `server/routes/settings/samsaraRoutes.js`); the worker lives in
    `samsara-integration`.
15. **Dropping a table is one code path, and it is allow-listed.** Settings →
    Retired Leftovers (`database/retiredLeftovers.js`) is the only place the
    application drops anything. A table name never travels from a request into
    SQL — the caller picks from four hard-coded groups. Drops run in passes on
    savepoints with **no `CASCADE`**, after first removing the foreign keys
    whose both ends are inside the doomed set — which is what makes a circular
    reference droppable without cascading, and never touches a constraint
    pointing at a surviving table. A leftover still referenced from outside the
    list fails and is reported rather than silently taking the referencing rows
    with it. The destructive half needs an exact typed
    confirmation phrase; the reversible half (role/permission rows, account
    deactivation) does not. Guarded by `tests/retiredLeftovers.test.js`,
    `tests/retiredLeftoversRoute.test.js` and
    `tests/retiredLeftoversPg.test.js`.
16. **One great-circle implementation.** `lib/geo/distance.js` owns it, and
    `haversineMiles` is `haversineMeters` converted rather than a second
    formula. Four consumers answer "is the truck there yet" from it — route
    completion, tracking start, fuel-stop proximity, ETA remaining distance —
    and two copies with two earth radii is two chances for those answers to
    disagree. `tests/geoDistance.test.js`.
17. **A static page split into assets keeps an explicit allow-list.** `/remote`
    and `/presentation` were single self-contained files until they passed the
    500-line limit. Their assets are served by named routes, never
    `express.static`: splitting one exposed file must not expose a directory.
    `tests/remoteRoute.test.js`, `tests/presentationPage.test.js`.

- **A truck number alone is not globally unique, and nobody is merged on one.**
  Three fleets number their trucks independently: Company 001, Owner-Operator
  001 and Lease 001 are three trucks driven by three people, and production
  already carries ten unit numbers on more than one active driver group. Truck
  identity is `(fleet_type, unit_number)` (`lib/drivers/fleetType.js`), the
  exact spelling — leading zeros and letter suffixes kept — is the only key
  strong enough to justify a write, and the digits-only form may suggest and
  never act (`lib/board/truck.js`). `unknown` is a real fleet type and never
  wins a match. A team pair is two people on one truck, not a duplicate. See
  `docs/architecture/dispatcher-board.md`.
- **The Dispatcher Board is the authority on today's assignment; Wenze is the
  authority on who a person is.** A disagreement between them is a finding, not
  a correction — Wenze does not pick a side on "which truck is this driver in".
  Joining the two is the most careful decision in the application, because a
  wrong join moves somebody's truck, their home-time clock and their bonus onto
  another human: **two independent facts must agree** — the truck by its exact
  spelling as `(fleet_type, unit_number)`, and the name STRICTLY, not by the
  fuzzy matcher that treats a shared surname as a match. One fact alone is a
  suggestion a person approves; two facts that disagree is a question, never a
  tie-break. The apply re-derives the whole decision under lock and refuses
  unless it still names the same person. A team pair that resolves to one
  person links neither. And when the two disagree about where a driver IS, that
  is a warning with nothing proposed — a board status means `home`, `working` or
  NEITHER (`lib/board/statusSemantics.js`), since a driver at REST or a truck in
  SHOP contradicts nothing, and a board snapshot over two hours old reads as
  `unknown` rather than as a side: a poller that stopped must never be quoted as
  evidence against Home Time.
  Its token travels in a query string, so every message about it leaves through
  `lib/security/redactUrls.stripUrls` and `last_error` may never hold a URL.
- **A truck is `(fleet_type, unit_number, seat)`, never a number.** Wenze runs
  three fleets that number independently, so Company 001, Owner-Operator 001 and
  Lease 001 are three trucks; ten numbers sit on more than one active group
  today. A team is two people on one truck in seats 1 and 2, not a duplicate.
  `unknown` is a real fleet type and never wins a match — it cannot be used to
  wave another driver's assignment aside, and it is never written as a guess.
  `lib/drivers/fleetType.js` is the one place the profile's vocabulary
  (`owner`/`company_driver`/`lease`) meets the Board's. See
  `docs/architecture/fleet-type-and-unit-identity.md`.
- **A failed board read never empties the snapshot.** "We could not read the
  board" and "nobody is on the board" are opposite facts, and only the second
  may set `present = false`. What may retire a row is an answer with something
  IDENTIFIABLE in it, not an answer with rows in it: zero rows, rows whose keys
  are all null (both identifying columns renamed), and rows naming a truck and
  nobody all reach an empty keep-list without the board having emptied. The
  keep-list is exactly what was STORED, never what was read. A pass is also ONE
  transaction, because "a failed pass changes nothing" has to hold for a pass
  that failed halfway. A board row is never deleted either — a vanished row
  keeps its history, because the Board itself keeps none.
- **A value from outside never reaches a typed column unchecked.** Postgres
  treats a string it cannot read as an error, not a null, so an external
  system's `TBD` aborts the statement and whatever pass was running behind it.
  `lib/database/timestampValue.js` is the only door — `toTimestampValue` for
  timestamps (its contract is deliberately the opposite of the display helper
  beside it) and `toNumericValue` for numbers, because NaN is ACCEPTED by a
  `double precision` column and REFUSED by an `integer` one, so a bad reading
  stores silently and poisons the next pass that reads it back. And a parameter
  beside an integer literal needs its own cast: `COALESCE($7, 0)` makes Postgres
  infer `integer`, which refused 12.25 miles against a `double precision`
  column and stuck one driver for a day.

- **Being in a Telegram group is not authorisation, and Wenze never edits its
  own source.** A finding can be answered by replying to it in the
  notifications group, and two lines make that safe. First, `control_operators`
  decides whose reply is obeyed — numeric ids only, seeded with the creator id
  and nobody else, the last one un-removable, every change audited; a reply from
  anybody else is recorded and never answered, because answering tells a
  stranger their reply was read. Second, a reply may only choose an action the
  question already OFFERED, checked both in the parser and again in the writer,
  and the visible text never names an action — so a sentence in a chat can never
  name an operation. The control modules reach the filesystem, a process, the
  network and git nowhere at all, asserted structurally by
  `tests/controlNoCodeAccess.test.js`; a code-level request becomes a note for a
  person. Telegram redelivers, so `control_replies` claims
  `(chat_id, reply_message_id)` BEFORE acting — without it a redelivered "yes"
  applies the same correction twice. See
  `docs/architecture/control-channel.md`.

- **One human is behind one Telegram account at a time, and a username is never
  evidence.** `driver_person_telegram_identities` records the account against
  the PERSON rather than the chat, so it survives a chat being recreated — and
  `uniq_person_telegram_open_account` makes "two people own this account"
  unrepresentable. A row is closed, never deleted: an account that moves owners
  leaves a trail. Linking is deliberately mean — a single-driver chat, exactly
  one candidate after bots, already-linked accounts and STAFF are removed (a
  dispatcher is in every driver's chat; three or more driver chats means not a
  driver), and that candidate's name must agree. A username is reassignable and
  is recorded as a snapshot only. A team chat is never resolved automatically,
  no account id reaches a finding title or a notice, and the apply re-reads the
  room under lock — somebody joining turns "the only candidate" into a
  question. It fills `driver_profiles.telegram_user_id` only when that column is
  NULL, because a person who typed one there decided something. See
  `docs/architecture/telegram-identity.md`.

### Code-structure rules (enforced by CI)

The 500-line cap, the two lint gates a build is not, the façade rule and the
one-way dependency flow now live in
[§9a `docs/brief/code-structure.md`](docs/brief/code-structure.md) — moved out
when this file passed the very cap it describes. `CLAUDE.md` states the same
rules as working instructions.

---
## 11. Testing and operational expectations

**Moved to [`docs/brief/testing.md`](docs/brief/testing.md)** — the commands,
the verified test baseline, the test endpoints and the operational safety rules.
It is part of this brief, split out for the same reason §9a was: this file had
reached the 500-line cap, and a section that grows by a number on every stage is
the wrong one to keep in the file everything else has to fit around.

---
## 12. Where to look next

| Need | Go to |
|---|---|
| Config, defaults, feature flags | `config/config.js` — read this first |
| Process orchestration, job startup, shutdown | `index.js` |
| HTTP mounting order and route inventory | `server/api.js` |
| Auth and permission middleware | `server/middleware/auth.js` |
| A feature's HTTP surface | `server/routes/<feature>Routes.js` |
| Business logic | `services/` — one concern per file, packages for large features |
| Queries | `database/<feature>.js` (`db.js` is only the re-export seam) |
| Schema (authoritative) | `database/baseline/*.sql` (source) → `database/schema.sql` (generated); new work in `database/migrations/` |
| Admin UI | `admin/src/App.jsx`, `admin/src/pages/`, `admin/src/api/` |
| Telegram handlers and send helpers | `bot/bot.js` (order!), `bot/handlers/`, `bot/senders.js` |
| Any brief section not in this file | `docs/brief/` (see the index above) |
| How to work in this repo (rules, safety, testing) | `CLAUDE.md` |
| The implementation workflow | `.claude/skills/implement/SKILL.md` (`/implement`) |
| Route Control + media-transport invariants | `docs/architecture/route-control.md` |
| Whose number texts a lead, WHICH message they send, and the RingCentral/TCR prerequisites | `docs/architecture/recruiter-sms-sender.md` |
| Samsara settings (the shared `samsara_settings` row, the shared-secret envelope for its API key) and missing-video recovery | `docs/architecture/samsara-settings-and-video-recovery.md` |
| Database: authoritative schema + migration rules | `database/baseline/`, `database/migrations/`, `docs/database/` |
| What was removed and why | `docs/ARCHIVED_FEATURES.md`, `docs/architecture/retired-*.md`, `docs/architecture/samsara-separation.md` |
| Clearing a removed feature's leftover tables and roles | Settings → Retired Leftovers; `database/retiredLeftovers.js` |
| Deployment checks | `docs/deployment/pre-deploy-checklist.md`, `render.yaml` |

### Working conventions

CommonJS, one concern per service file, `console.*` with a structured prefix
(`[API]`, `[BOT]`, `[DB]`, `[SCHEDULER]`, `[LEFTOVERS]`, …), additive SQL only, and
a test in `tests/` for whatever you changed. Match the surrounding code.
**When in doubt about production impact, stop and ask rather than guessing** —
and if a behavior is genuinely ambiguous, say so instead of inventing it.
