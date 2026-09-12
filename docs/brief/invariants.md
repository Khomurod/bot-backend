<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list this expands on. -->

# §9. Decisions and behavior that must be preserved

Split out of `APP_BRIEF.md` when that file reached the repository's 500-line
limit with no room to record another invariant — the same treatment §4, §9a and
§11 got, and for the same reason: a section that grows by an item on every stage
does not belong in the file everything else has to fit in. **Nothing was
dropped, and the numbering is unchanged**, so every existing reference to
"`APP_BRIEF.md` §9" still means exactly this.

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

18. **A captured payment message is never overwritten by what was read out of
    it.** `finance_messages.text` is the record; `parse_status` / `parse_json` /
    `parser_version` sit beside it. The money-code parser is provisional — it
    has never been shown a real message — so a tightened one must be able to
    re-read exactly the rows the provisional one produced, and that is only
    possible while the original text is still there. Only a `parsed` message
    produces a money-code row; `ambiguous` means the parser refused to pick,
    which is an answer, not a failure. Capture cannot be switched on against a
    chat nobody validated, a repeat is recorded and never acted on, and message
    text never reaches the application log. `tests/financeCapturePg.test.js`,
    `tests/financeSettingsRoute.test.js`,
    `docs/architecture/finance-monitor.md`.

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
  own source.** A finding can be answered by replying to it in the notifications
  group. `control_operators` decides whose reply is obeyed — numeric ids only,
  seeded with the creator id and nobody else, the last one un-removable, every
  change audited; anybody else's reply is recorded and never answered, because
  answering tells a stranger it was read. A reply may only choose an action the
  question already OFFERED, checked in the parser and again in the writer, and
  the visible text never names an action — so a sentence in a chat cannot name an
  operation. The control modules reach the filesystem, a process, the network and
  git nowhere at all (`tests/controlNoCodeAccess.test.js`); a code-level request
  becomes a note for a person. Telegram redelivers, so `control_replies` claims
  `(chat_id, reply_message_id)` BEFORE acting. A model reads only a reply the
  fixed rules could not, picks from the same offered keys, supplies no value that
  lands in a record, and fails to "unclear" rather than a guess. An answer is
  remembered against the CONDITION, not the driver, so a changed situation is
  asked again — and a remembered "yes" is never re-applied, because a standing
  permission belongs on the Automation screen. See
  `docs/architecture/control-channel.md`.

- **One human is behind one Telegram account at a time, and a username is never
  evidence.** `driver_person_telegram_identities` records the account against
  the PERSON rather than the chat, so it survives a chat being recreated — and
  `uniq_person_telegram_open_account` makes "two people own this account"
  unrepresentable. A row is closed, never deleted: an account that moves owners
  leaves a trail. Linking is deliberately mean — a single-driver chat, exactly one
  candidate after bots, already-linked accounts and STAFF are removed (a
  dispatcher is in every driver's chat; three or more means not a driver), and
  that name must agree. A username is reassignable and is a snapshot only. A team
  chat is never resolved automatically, no account id reaches a finding title or
  a notice, and the apply re-reads the room under lock. It fills
  `driver_profiles.telegram_user_id` only when NULL, because a person who typed
  one there decided something. See
  `docs/architecture/telegram-identity.md`.

### Code-structure rules (enforced by CI)

The 500-line cap, the two lint gates a build is not, the façade rule and the
one-way dependency flow now live in
[§9a `docs/brief/code-structure.md`](code-structure.md) — moved out
when this file passed the very cap it describes. `CLAUDE.md` states the same
rules as working instructions.
