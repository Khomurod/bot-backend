# Which dispatch team a driver belongs to

Read this before changing the Driver Raises roster, the Sunday review round, or
anything that decides which dispatcher reviews which driver's rate.

## The rule

**The Dispatcher Board is the operational source for who dispatches a driver.**
Wenze does not remember a roster somebody typed; it rebuilds one from the
Board's dispatcher column, which is the column dispatch keeps current because
they work from it.

A driver's dispatch team is therefore derived, every week, from two questions
answered by two pure modules:

| Question | Module | Refuses when |
|---|---|---|
| Which PERSON is this Board row about? | [`lib/identity/boardResolution.js`](../../lib/identity/boardResolution.js), through [`services/dispatchBoard/rowPeople.js`](../../services/dispatchBoard/rowPeople.js) | the truck and the name do not agree, the truck matched on digits alone, or two rows name one person |

**A team row is two drivers, and both of them count.** One board line reading
"A / B" on truck 310 is two people with two dispatch teams and two home-time
cycles. `decideTeamBoardLink` asks about each member separately; handing the
combined name to the single-driver resolver asks an unanswerable question — two
holders on one truck read as ambiguous — and would drop both off every roster.
Because the caller knows *which* member it is asking about, that ambiguity is
re-examined against the seats and settled only when the truck matched on its
real spelling and the member's name agrees strictly with exactly one of the
people in it: the same evidence standard as any other auto link, applied twice.
Two names that resolve to one stored person link **neither** — that is a
composite row somebody splits by hand.
| Which TEAM is that dispatcher on? | [`lib/raise/dispatcherTeam.js`](../../lib/raise/dispatcherTeam.js) | the name maps to no team, or to more than one |

Neither may guess. A driver the pair cannot settle is left **off** a roster and
filed as `raise.driver_unplaced` for a person, rather than put on a plausible
one — a wrongly-placed driver has the wrong dispatcher decide their pay rate,
and nothing about the review form would look wrong.

## What the dispatcher matcher does and does not tolerate

Forgiving about spelling, exact about identity:

* case, surrounding whitespace, punctuation and accents are folded
  (`josé núñez` and `JOSE NUNEZ` are one name)
* `TEAM`, `DISPATCH`, `DISPATCHER`, `DISP`, `DSP` and their plurals are stripped
  **from the front and the back only** — one in the middle is part of the name
* a full name is matched before a given name, so `Charles Whitfield` is not
  decided by whoever owns the given name Charles
* a given name must be at least three characters — `JO` is an initial

It will **not** do near-matching. `steve` does not become `Steven`, and
`Charlotte` is never `Charles`. A single-word cell that matches one team's name
*and* another team's dispatcher's first name is ambiguous, not a winner.

## Sunday, in order

[`services/raiseApprovalService.js`](../../services/raiseApprovalService.js)
`openRoundAndPost` runs the rebuild as the **first** thing it does — before the
review group is resolved and before the round row exists:

1. refuse unless the Board is on, has been read, read successfully, and was read
   within `MAX_BOARD_AGE_HOURS` (6)
2. rebuild every team's roster from the current snapshot
3. only then mint the round, build the link and post it

**A Board that cannot be trusted stops the round.** The exception from
`reconcileRosterFromBoard` is deliberately not caught: a round built on an
un-rebuilt roster looks exactly like a correct one, and the dispatcher opening it
has no way to tell. The refusal is not silent either — it files
`raise.roster_not_rebuilt` (serious), because a review that never arrives is as
invisible as a wrong one. The scheduler releases its `service_runs` claim on the
failure, so the next tick retries.

Send now reconciles too, for the same reason.

## Idempotency

Running it twice must not double anything, because it runs on a schedule **and**
from the admin's Send now, and the two can land together:

* a driver already on the right team is a `keep` — no write
* `applyBoardAssignment` is one transaction that reads the current row
  `FOR UPDATE`, so two passes cannot both insert
* a move **closes** the old row rather than editing it; the closed row is the
  record of where the driver used to be
* findings are upserted by `(check_key, subject)` and cleared findings resolve,
  so the unplaced list does not fossilise
* the round itself is still guarded by `claimServiceRun('raise', 'weekly:<end>')`

**A roster write that fails aborts the rebuild.** A constraint violation or a
dropped connection halfway through leaves some teams current and others as they
were last week — indistinguishable from a correct rebuild to everybody who reads
the review form. `reconcileRosterFromBoard` throws `ROSTER_WRITE_FAILED`, so the
round is not minted, the scheduler releases its claim and the next tick retries.
A *finding* that could not be filed is reported but does not abort: the driver is
genuinely off every roster either way, and refusing the whole review over a
warning row trades a real problem for a bigger one.

## Human overrides

Manual assignment survives as an explicit override, not as a parallel system.

* assigning a driver by hand sets `assignment_source = 'manual'` together with
  `manual_override_at` and `manual_override_by`
* the rebuild **never** rewrites a human override. It reports the disagreement
  (`overrideDisagrees` in the summary, a `Manual` badge and the board's opinion
  in the admin) and leaves the row alone
* a human override is not retired when the driver stops being eligible either —
  somebody put them there
* **Hand back to board** (`POST /team-drivers/:id/release-to-board`) clears the
  override, and the next rebuild owns the row again

Normal operation needs no manual assignment at all. If it does, that is a
finding to read rather than a roster to type.

### The TIMESTAMP is the override, not the word

`assignment_source = 'manual'` alone is **not** a human override. The test is
`manual_override_at IS NOT NULL`, in the pure planner
(`lib/raise/rosterPlan.js` `isHumanOverride`) and in both SQL guards in
`database/raiseApproval/teamDrivers.js`. There is exactly one rule, in one
predicate, and nothing may re-derive it from the source column alone.

This is not a nicety. Migration 0058 stamped every roster row that already
existed `'manual'`, reasoning that somebody must have typed it — correct about
the past, and wrong about the consequence. Those rows carry no
`manual_override_at`, because no human ever pressed the button that sets it, so
under a source-only test the entire pre-existing roster was permanently exempt
from every rebuild. The Board could never take ownership of a single driver who
was already on a team, which is most of the fleet, and the reconciliation that
runs before each Sunday round quietly did nothing.

Migration `0062_legacy_raise_assignments_follow_board.sql` moves those rows back
to `assignment_source = 'board'`. It is additive, idempotent and narrow —
`WHERE assignment_source = 'manual' AND manual_override_at IS NULL` — so a
genuine override, which always has the timestamp, is untouched. Historical
rounds and submissions are snapshots and are not read by it at all.

## Identity

The roster is keyed on the permanent person where one is known, then the driver
profile, then the chat — **never on a truck number**, because trucks change and
a driver who moves from 310 to 999 is the same person with the same dispatcher.
`lib/raise/rosterPlan.js` `personKeyOf` is the whole of that rule.

## History is never rewritten

`raise_round_picks` and `raise_round_submissions` snapshot the driver list at the
moment a dispatcher answered. The rebuild touches only the CURRENT roster
(`dispatch_team_drivers`), so a completed review keeps showing the team and the
drivers it was actually answered for, whatever the Board says afterwards.

## Tests

* `tests/raiseDispatcherTeam.test.js` — the matcher and the plan, including
  every refusal
* `tests/raiseBoardRoster.test.js` — the rebuild: freshness, placement,
  idempotency, overrides, Needs Review
* `tests/raiseBoardRosterPg.test.js` — the transaction, the move, the override
  under lock, a legacy `manual` row with no timestamp being moved and retired,
  and history staying put
* `tests/raiseApproval.test.js` — the ORDER (reconcile, then mint, then send)
  and the refusal stopping the round
