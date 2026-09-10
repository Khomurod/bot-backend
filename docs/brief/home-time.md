<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list. -->

# §4b. Home time

Everything about a driver going home and coming back: how Wenze decides that a
driver ASKED, that they ARE home, and that they went back to WORK; what it tells
the three managers; and the invariant that every home-time cycle must close.

Split out of §4 when that document passed the 500-line limit — home time is the
largest single workflow in the application and the one with the most rules that
were written after something went wrong.

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
  `queues.homeTimeInternalAlerts.exhausted` and
  `queues.homeTimeManagerNotices.failed` (5-minute cache). It deliberately
  does **not** affect `healthy` or the status code: Render and the uptime monitor
  read those, and an undeliverable alert queue is an operator's problem, not a
  reason to declare the service down. `tests/healthQueueSignal.test.js`.
- **`/api/health` names the commit it is running** — `commit.sha` / `commit.short`
  from `RENDER_GIT_COMMIT`, `null` when unset. `main` auto-deploys, and before
  this the only evidence a merge was live was an uptime that lined up with the
  merge time. `tests/healthDeployCommit.test.js`.
- **`/api/health` shows what the system is doing about its own records** — the
  `operations` block (counts and timestamps only; see "Operational
  consistency" in `self-checking-and-ai.md`), so a deploy's background repair can be verified
  from the same endpoint that names the commit. Withheld when the database is
  down; `available: false` rather than a 5xx when the summary itself fails.
  `tests/healthOperationsBlock.test.js`.

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
- **A second open stay per group can no longer come into being (Phase 3-G).**
  A `road → home` insert first closes EVERY stay still open for that driver —
  on this chat or any chat the same person held before — with the road start it
  is about to record as their return (a `road → home` can only follow a road
  state, so that moment *is* the observed return: class-B evidence, seen from
  this side). `getOpenHomeStay` is still `LIMIT 1`; it no longer matters,
  because the read the service uses is `listOpenHomeStays(groupId)`, which is
  person-aware. The ~65 already-open cycles still need the Stage 3 repair.
- **The home stay follows the person.** A driver who went home on the old
  truck's chat and returned to the road on the new truck's chat closes the stay
  that began on the old chat — one driver, one cycle — through the `person_id`
  migration 0026 stamps on `driver_road_history`. The admin overview shows a
  leg under the driver's CURRENT chat (`current_group_id`; the chat it was
  recorded on stays as `source_group_id`, and the modal says "recorded on an
  earlier chat").
- **`ensureOpenStayIndex()` runs at boot, after the migrations** (`database/
  homeTime/integrity.js`). It counts groups with more than one open stay and
  creates the partial unique index `uniq_driver_road_history_open_stay`
  (`group_id WHERE return_to_road_at IS NULL`) **only when there are none**;
  otherwise it logs which groups block it and stands down. It is deliberately
  NOT a migration — a migration that met the 25 production duplicates would
  fail, and a failing migration fails boot. Nothing on its path can throw.
- **A road clock restarted on a new chat is proposed for carrying, never
  carried automatically.** `home_time.clock_reset_on_group_change`
  (`checks/homeTimeContinuity.js`) fires when a person's current chat is on the
  road since a moment their previous chat was already on the road, the new clock
  began when the new chat did, and the old chat fell silent first — the RUSLAN
  ABDULLAEV shape, four weeks of accrual lost to a recreated chat. The action
  `home_time.carry_road_clock` is tier **approval**: it changes a future payout,
  so a person confirms; it copies the old chat's `state_since` exactly and
  carries the larger extra-week watermark so announced weeks are not announced
  again. Guarded by `tests/homeTimeContinuity.test.js` and
  `tests/homeTimeContinuityPg.test.js`.
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
- **The 98 undeliverable internal alerts get a terminal state, not a retry.**
  Every one sat at attempts = 6 = MAX_ATTEMPTS with `400: Bad Request: chat not
  found` — a dropped minus sign in `internal_clarification_group_id`. Migration
  0014 fixed the id; it must not fix the pile, because re-driving months of
  stale home-time alerts into a live staff chat would be its own incident.
  Migration 0022 widens the state CHECK to allow `'abandoned'` and **moves
  nothing** — the move is a Tier-1 correction, dry-run first, audited,
  revertible, applied by a person. `'failed'` is the outbox's *"still looking at
  this"* state and is what `/api/health` reports, so leaving them there reports
  98 problems forever and trains everyone to ignore the number: the exact
  failure that let the original 101 sit unnoticed. Nothing is deleted — the row,
  the attempt count and `internal_alert_last_error` all stay, so what was lost is
  still answerable. **One** finding for the pile, not 98 — identified by a digest
  of the pile's CONTENTS, so the same pile stays one row across sweeps while a
  LATER pile is a new incident. A fixed id would have been permanently
  suppressed after the first apply: `resolveClearedFindings` only touches
  `status = 'open'`, so an applied finding stays `applied` forever and
  `upsertFinding` preserves every status except `resolved`.
- Guarded by `tests/homeTimeCycleInvariant.test.js`, which asserts the
  **negative**: after a `home → road` change by any route, no open cycle may
  remain. Nothing asserted that before, which is why it broke.
- **An inactive group STANDS DOWN; it is not merely skipped.** The reminder
  service used to `continue` past an inactive group before claiming, leaving
  `next_reminder_at` set — and `isHomeTimeRequestOutdated` reads a set schedule
  as "reminders still pending → still active". The request therefore stopped
  being reminded AND stopped being expirable: no reminder, no 21-day stale
  sweep, no terminal state, forever. The reminder is still not sent (a driver
  whose group is gone must not be messaged); only the immortality is fixed. The
  clearing UPDATE re-checks the group's state at write time: an admin can
  reactivate a group between the due-row read and the write, and nothing
  reschedules a reminder on reactivation.
- **A home start past the horizon is asked about, not stored.** `2027-01-02` on
  request 139 is a mis-parsed year that `isReasonableWindow` waved through,
  because a full year is inside its horizon. `classifyWindowAgainstPolicy`
  (pure) separates *"are these dates plausible"* from *"does the company grant
  them"*, and the service re-opens the disputed dates so the existing
  clarification flow asks about them — no new send path, no new status.
  Three things it has to get right, each of them a way the gate leaks:
  **both** ends are cleared (a corrected near-term start merging with the stale
  far-future return produces a `too_long` window, which is deliberately
  accepted — so the mis-parsed year would survive the very clarification meant
  to catch it); a **partial** window is judged on the date it has (requiring
  `complete` let "home 2027-01-02" with no return date through); and the
  **manager-tagged** path gets the same check, because a mention makes a
  request more official, not more likely to be right about the year.
  **An over-allowance window is deliberately NOT refused**: the subsystem
  already answers that properly, by recording the request and replying with a
  firm reminder of the four-week rule while withholding the 👍. Refusing it
  would replace a clear answer with a loop.
- **The admin no longer calls an open cycle a completed trip.** The table was
  headed "Completed trips" and rendered every road-history row, so 74 of 79
  production rows looked finished. It now has a **Back on road** column showing
  the return date or an explicit *Still home*.

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

- **Home time is reported, not approved.** The Approve / Do-Not-Approve buttons
  are gone. They asked a question the company had already answered — a driver
  who has been out five weeks is going home, and nobody pressing a button
  changed whether the truck stopped — and they were the ONLY message: nobody was
  told when the driver actually got home, or when they went back to work.
  Wenze now reports **three separate events**, each buttonless and each tagging
  all three managers (`@tomr_robins0n @SaffieBNett @amelia_wenze`):
  **Home-Time Request** (the driver asked — an intention, not an arrival),
  **Driver Is Home** (evidence they actually reached home; the cycle starts) and
  **Driver Back on the Road** (evidence they returned to work; the cycle closes,
  with the measured days at home). Words in `lib/homeTime/managerNotice.js`
  (pure), delivery in `services/homeTime/managerNotices.js`.
- **Each event is told exactly once, durably.** Every one of them is re-derived
  by something that repeats — the message pipeline, the return-to-road watcher,
  a restart — so the promise cannot live in memory. It lives in
  `home_time_manager_notices.event_key`, which is UNIQUE and inserted with
  `ON CONFLICT DO NOTHING`: the tenth re-derivation of the same arrival inserts
  nothing and tags nobody. Delivery is the usual durable outbox (lease, attempts
  counted at claim time, backoff ladder), retried on the reminder ticker, and an
  undeliverable notice is countable on `/api/health` beside the internal-alert
  queue. Migration 0029; `tests/homeTimeManagerNotice.test.js`,
  `tests/homeTimeManagerNoticesPg.test.js`.
- **Wenze notices when a driver goes back to work, without being told.** A
  driver rarely says "I am back on the road" — they get a load and start
  driving, which is why the only writer of `return_to_road_at` used to be a
  chat message and why production reached 74 open cycles out of 79.
  `services/homeTime/returnToRoadWatch.js` watches every driver currently at
  home every 12 minutes and reads two things the company already collects: the
  Datatruck active-load board, and the truck's own GPS through the same
  Samsara / Factor / Leader fleet fetch the Live Locations map uses.
- **A load is never a departure on its own.** Dispatch assigns loads to drivers
  who are still at home; that is planning, not work starting. `high` requires
  BOTH an active load AND proven movement (fresh GPS, and either the truck left
  the area it was parked in or it was seen moving twice), as a hard gate no
  score can talk its way around. A truck parked where the driver went home
  scores *negative*. Rules in `lib/homeTime/returnEvidence.js`, pure and
  unit-tested against each scenario.
- **Confidence decides who acts.** `high` files
  `home_time.returned_to_road`, which the correction registry may apply —
  audited, capped at 25 a run, and revertible like every other action.
  `medium` files `home_time.return_to_road_unclear`, a check with **no action
  registered at all**, so it can only ever be read by a person. `low` files
  nothing. Two check keys rather than one is what makes "medium never changes
  state" true by construction.
- **The correction re-derives before it writes.** It refuses unless the driver
  is still marked home, the watch still reads high, the look at that truck is
  under 90 minutes old, and the cycle is still open. The manager notice is
  written in the SAME transaction, so a rolled-back correction cannot leave
  three managers told about a return that did not happen.
- **Where "home" is, is remembered — nothing more.** There is no stored GPS
  history in this application and no recorded home address for any driver, so
  `home_time_return_watch` keeps one row per driver at home: where the truck was
  parked (set only from a STATIONARY sighting — anchoring mid-drive would put
  "home" on an interstate), the latest sighting, the furthest it has been, and
  the last verdict. Migration 0030.
- **It costs nothing when nobody is home.** A tick asks the database first; with
  no driver at home it makes no provider calls at all. With sixteen it makes the
  same two requests as for one — one fleet fetch, one order window — and matches
  locally.
- **A completed request is `recorded`, not `pending`.** Nothing waits for a
  decision, so nothing sits in a status that means "waiting for one". Historical
  `approved` / `denied` rows are untouched and still read: `homeTimeEfficiency`
  classifies an approved exception from them, and an administrator can still
  record one from the admin panel. Legacy `pending` rows are also left exactly
  as they are and are simply read as settled. Old cards still in the group get
  their buttons retired on the next press, with a note that approval is no
  longer needed — `tests/homeTimeRetiredApproval.test.js`.
- **Every home-time date is a `America/Chicago` calendar date.** The state
  machine, the date resolver, the clarification flow and every AI prompt all
  reason in Central; a UTC instant must be zoned before it becomes a date.
  `homeTimeRequestService.js` used the process default (UTC on Render), so a
  driver arriving home after 19:00 Central had TOMORROW recorded as their home
  start — the window and the bonus math that reads it were a day out. Guarded by
  `tests/homeTimeCentralDates.test.js`, which pins the instant rather than
  trusting the clock.
