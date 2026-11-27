# When a driver is actually home, and when they left

Read this before changing Home Time requests, the home/road state machine, the
home-cycle history, or anything that decides a driver went home.

## A request is a message, not a ticket

A driver asking for home time is **recorded, sent to the configured Telegram
destination, and that is the end of it.** Three managers are told. Nobody
approves it, nothing waits for a reply, and nothing is inferred from the absence
of one.

What was removed, and must not come back:

* approve / decline buttons and the workflow behind them (already retired)
* a request "expiring" for want of an answer, and the `status = 'expired'` that
  recorded it
* the sweep announcing "N home time requests expired without an answer"
* the retention signal `home_request_unanswered`, and the
  `unanswered_home_requests` count behind it — which was most of what produced
  "34 drivers worth a call"

**A home time request is never evidence that a driver went home.** It is a plan.
The two questions are answered in completely different places, and a reviewer who
blurs them will reintroduce the original bug.

What survives is housekeeping only: a request whose dates have gone by is set to
`status = 'closed'` so it stops blocking the next one. The count goes to the run
ledger for the worker's health; no human is told, because the calendar advancing
is not an operational problem. `'expired'` stays in the CHECK constraint for the
rows already carrying it — history is not rewritten — and nothing writes it.

**Wenze does not ask the driver for dates.** The clarification conversation —
`awaiting_dates`, `awaiting_home_start`, `awaiting_return_to_road`, the two
reminders twelve hours apart, `clarification_unanswered`, and the staff alert
that named the missing fields while driver messaging was off — is gone with the
rest of it. It existed to collect two **planned** dates: a guess about next
week, typed by somebody about to drive home. Home In and Home Out are not read
from a plan (see the next section), so the whole conversation cost the driver
messages and staff attention to produce a number nothing reads.

What replaced it is one function, `recordAndPostRequest` in
[`services/homeTimeClarificationFlow.js`](../../services/homeTimeClarificationFlow.js):
record the request with whatever dates were actually said (any of them may be
null), tell the three managers, reply to the driver once, stop. `status` is
`recorded` and `next_reminder_at` is always null.

`home_time_settings.driver_clarification_enabled` still governs one thing —
whether Wenze may write in a driver's group. It has never governed whether a
request is recorded, and it does not reach the manager notice, which goes to a
staff chat.

Rows already sitting in an `awaiting_*` status keep their status and their
dates. Nothing chases them; the housekeeping sweep closes one whose window has
passed, and a driver who writes again is heard as making a fresh request rather
than answering a question Wenze has stopped asking.

**`next_reminder_at` is history, and `isHomeTimeRequestOutdated` does not read
it.** The predicate used to return false whenever the column was set —
"reminders still pending, so the flow is still active" — which was true while a
worker existed to send them and clear it. Nothing writes the column now, so on
every row that predates the removal it is frozen at whatever was last
scheduled. Reading it would have made those rows uncloseable **forever**, and an
open request blocks its driver's next one: that driver could never ask for home
time again. This subsystem has already been bitten once by exactly that
immortality (see `docs/brief/home-time.md`), which is why the column is now
inert rather than merely unwritten.

**Asking twice is one ask.** `recorded` is deliberately outside
`OPEN_REQUEST_STATUSES`, so it cannot serve as the duplicate guard the
`awaiting_*` row used to be — and the manager notice is keyed `request:<id>`, so
a second row tags all three managers again. Both recording paths (the driver's
own message and an approver mention) therefore call `mergeIntoRecentRequest`
first: a second ask within `DUPLICATE_WINDOW_HOURS` (24) updates the request
already recorded, filling in any date now supplied, never overwriting one
already there, and telling nobody. Removing a reminder loop only to replace it
with duplicate notices would be no improvement.

## Home In and Home Out come from operational evidence

Two engines, reading two different kinds of evidence, ending at the same state
machine:

| | Evidence | Module |
|---|---|---|
| **Home In** | the Dispatcher Board says HOME or VACATION | [`lib/homeTime/boardPresence.js`](../../lib/homeTime/boardPresence.js) + [`services/homeTime/boardPresenceWatch.js`](../../services/homeTime/boardPresenceWatch.js) |
| **Home Out** | the Board puts the truck back in the dispatch pool | the same pair |
| **Home Out** | a real load AND proof the truck moved | [`lib/homeTime/returnEvidence.js`](../../lib/homeTime/returnEvidence.js) + [`services/homeTime/returnToRoadWatch.js`](../../services/homeTime/returnToRoadWatch.js) |

They do not compete. Once a stay is closed, `listDriversAtHome` stops returning
the driver and the return watch has nothing to look at; once the state agrees
with the Board, the board watch writes nothing. Whichever sees it first wins, and
the second one goes quiet.

**Every write goes through `applyStateTransition`.** That function owns the
state machine, the road-history cycle and the bonus. Writing `driver_home_status`
directly is exactly what left 74 of 79 cycles open in production, so neither
watch has the ability to do it.

### READY is not "working", but it does end a home stay

`lib/board/statusSemantics.js` keeps three vocabularies, and they answer three
different questions:

* `boardSaysHome` — HOME, VACATION
* `boardSaysWorking` — DISPATCHED, ENROUTE, COVERED, HOLD FOR LOAD (the last
  two came with the board service in November 2026; the owner: both mean
  working). **READY is deliberately not here**:
  a truck marked available proves nothing about whether its driver is driving,
  and folding it in would make Wenze accuse a resting driver of contradicting
  their own home-time record. The contradiction checks that read this one were
  removed in October 2026; nothing reads it today.
* `boardEndsHomeStay` — READY, RESERVED, DISPATCHED, ENROUTE, COVERED, HOLD FOR
  LOAD. Asked **only** of
  a driver Wenze already has at home: dispatch has put the truck back in the
  pool, so the stay is over.

REST and SHOP end nothing. A driver can rest at home, and a truck can sit in a
shop while its driver is on their couch.

### Three rules against flapping

Two integrations updating at different speeds is the failure this has to
survive, so the pure rule refuses far more often than it acts:

* **Settle** — the Board must have held a status for `confirmMinutes` (20)
  before Wenze acts on it. This is why `dispatch_board_rows.status_changed_at`
  exists separately from `last_changed_at`: the latter also moves when an ETA is
  retyped, which would restart the window for a driver whose status never moved.
* **Dwell** — a state Wenze set within `dwellMinutes` (30) is not changed back.
* **Hold** — the driver's own message, within `driverRecentMinutes` (120),
  outranks the spreadsheet. A Board a few minutes behind a driver's "I'm
  rolling" produces **silence**, not a Needs Attention item.

A stale snapshot (older than `freshMinutes`) decides nothing and raises nothing —
the poller's own health already reports a Board nobody can read.

**A board status older than the state it would replace is not new evidence.**
The driver writes "Status: Road" at noon, the board has said HOME since eight
that morning, and two hours later the hold expires. That cell has not moved
since *before* the driver spoke, so it cannot describe something that happened
after — and acting on it would open a home cycle timed earlier than the road leg
it closes, which `applyStateTransition` then measures as zero days out with a
bonus computed over negative time. It is refused, never clamped to the state's
start: a zero-length road leg is a fabricated fact rather than a missing one.
The disagreement still reaches a person by the twelve-hour rule, because
`disagreedHours` counts from whichever of the two timestamps is later.

A hold that never resolves does become a question. Once the two have disagreed
for `reviewAfterHours` (12) the decision returns `review` and the watch files
`home_time.board_disagrees_with_state` (warning, **no proposed change** — which
of two systems is right is precisely what nobody here knows).

`MAX_TRANSITIONS_PER_PASS` (25) caps one pass, so a Board that suddenly claims
the whole fleet went home becomes a slow problem somebody notices rather than a
fast one nobody can undo.

## A visit under 12 hours is not going home (owner, 27 November 2026)

The settle, dwell and hold above stop Wenze reacting to a Board that is minutes
behind. They do not stop a Board that really did say HOME for forty minutes:
in the 30 days to 27 November, 15 of 53 company-driver home stays lasted under
12 hours and 8 under two. Each one ended the road trip it interrupted, so the
trip's extra weeks were split, the bonus was decided on a home stay of 0 days,
and accounting was told the next trip "came home early after 0 days on the
road" (two such alerts went out in November and moved the cards to EARLY).

The rule is `lib/homeTime/briefVisits.js`, applied where the record is written
(`services/homeTime/briefVisits.js`, called from `applyStateTransition`):

* **A home stay under 12 hours is folded** into the trip it interrupted. The
  row is kept and marked (`folded_at`, `folded_reason` with the figures it
  held), its bonus is zeroed, and the driver's road clock (`state_since`) goes
  back to the trip's start — so the next real arrival records the WHOLE trip
  and its whole bonus. A folded row is left out of the history, the efficiency
  report, the bonus queue and accounting's verdicts. The managers' "back on the
  road" notice says "Short stop (40 min), under 12 hours: not counted as home
  time" instead of "0 days at home".
* **Home again under 12 hours after leaving reopens the stay** before it
  (`reopened_at`, `reopened_note`): no trip is recorded, and the stay's home
  days are counted from the FIRST arrival when it finally closes. The managers
  are told both the return home and the final departure, each under a key of
  its own (`staySubject` in `lib/homeTime/managerNotice.js`) — the first
  round's keys would otherwise swallow them.
* **Neither happens once the stay's bonus is posted or decided** (both writes
  are guarded in SQL). The bonus is decided only `SETTLE_HOURS` (16) after the
  return — the 12 hours plus the four the Board watch may take to notice in
  economy mode — so a stay that may still be reopened is never judged half-way.
* **`driver_home_status.state_changed_at`** is when the state last changed.
  After a fold `state_since` is weeks earlier, and the Board watch's dwell and
  "the board predates the state" rules are about the change, so it reads
  `GREATEST(state_since, state_changed_at)`: a Board still saying HOME from
  before the driver said "Ready" must not reopen a stay the clock skipped.
* **Every write and reader is best effort to the old behaviour**: a fold or
  reopen that cannot be made (an error, a row someone moved first) records the
  transition the ordinary way, as before this rule.
* **One way to count days** — complete 24-hour periods (`wholeDays`): the
  bonus's "home more than 4 days", accounting's "overstayed", the notices and
  the return-watch correction all use it. It used to be counted twice — once
  in calendar days in the process's time zone — and the two disagreed by a day
  across a clock change.

The return-watch correction (`returnToRoadActions.js`) closes a stay without
folding: it acts only on a truck that has really left. Accounting's reading
(`lib/homeTime/ownViolations.js`) applies the same two rules again, so a record
written before this, or by that path, is judged the same way.

## The cycle history says where each side came from

`driver_road_history` carries `opened_by` / `opened_evidence` and `closed_by` /
`closed_evidence`. A manager reading "home 14–18 Sep" can ask whether a person
said so or a spreadsheet did; a correction nobody can trace is a correction
nobody can argue with. Sources: `driver_message`, `dispatcher_board`,
`admin_correction` (the Home Time page), `screenshot_import`, `evidence` (closed
because a later road period was observed). The admin flip and the import used
to record `driver_message` for a change no driver wrote.

Rows written before this existed are left blank rather than backfilled with a
guess — inventing provenance is the one thing these columns exist to prevent.

Guarantees, all covered by tests:

* one open cycle per driver at a time
* a repeated HOME is idempotent (the state machine touches, does not transition)
* a repeated READY or a second load does not close the cycle twice
* a truck or group change does not lose the state: everything is keyed on the
  permanent person through the open `driver_person_groups` association
* the bonus is unchanged by any of it — `bonus_usd` is computed at insert —
  except a folded brief visit, whose bonus moves to the trip that continues

## Tests

* `tests/homeTimeBoardPresence.test.js` — the pure rule (mostly cases that do
  nothing) and the pass
* `tests/homeTimeBriefVisits.test.js`, `tests/homeTimeBriefVisitsPg.test.js` —
  the 12-hour rule: days, fold, reopen, their guards, the notices' keys, the
  settle, and the long-trip question read from the record
* `tests/homeTimeCycleEvidencePg.test.js` — provenance, one-close-only, the
  `closed` status, and `status_changed_at` ignoring an ETA edit
* `tests/homeTimeApproval.test.js`, `tests/homeTimeExpiry.test.js` — closing is
  housekeeping and nothing is announced
* `tests/homeTimeSilentMode.test.js` — the managers are told in both modes, the
  driver gets one acknowledgment and never a question, and the clarification
  functions stay deleted
* `tests/homeTimeReminderService.test.js` — the reminder loop stays gone
* `tests/homeTimeCentralDates.test.js` — the Central-date rule where it still
  lives: the manager notice and the housekeeping sweep
* `tests/retentionSignals.test.js`, `tests/retentionWatch.test.js` — no signal
  is generated from a non-response
