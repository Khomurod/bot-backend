# Fleet type, and why a truck number is not a truck

**Read this before touching anything that compares unit numbers, decides who is
in which truck, or targets a broadcast by driver type.**

## The fact everything here follows from

Wenze runs three fleets that number their trucks **independently**:

| Label on the board or in a group title | Fleet |
|---|---|
| `(COMPANY DRIVER)` · `(COMPANY DRIVERS)` · `(COMPANY)` | `company` |
| `(LEASE DRIVER)` · `(LEASE DRIVERS)` · `(LEASE)` | `lease` |
| *no label* | `owner_operator` |
| anything else | `unknown` |

So **Company 001, Owner-Operator 001 and Lease 001 are three different trucks
driven by three different people.** Production carries ten unit numbers on more
than one active driver group — `001` on four of them — and to anything that
compares bare numbers, those look like one truck being fought over by four
drivers.

A truck's name is `(fleet_type, unit_number, truck_owner, seat)`. Nothing less
identifies one. The owner joined in November 2026 (below): on the board the name
after a number is the truck's **owner**, and several owners reuse the same
number.

## `unknown` is a real answer, and it never wins a match

A row Wenze cannot place is a **question**, not a default. Two consequences,
both enforced in code:

- `toFleetType()` maps an unreadable stored `driver_type` to `unknown`, **not**
  to `owner_operator`. The unlabelled default belongs to the *board's naming
  convention* — where an absent label really does mean owner operator — and
  borrowing it here would turn "we do not know" into "we decided".
- `holderContests()` treats `unknown` on **either** side as in the way. You
  cannot use a fleet you could not read to wave another driver's assignment
  aside.

`toDriverType(unknown)` returns `null` rather than a token: the column is
nullable, and writing `owner` for a driver nobody has classified stores a guess
that later reads as somebody's decision.

## A team is two people on one truck

Seats 1 and 2. They are **not** duplicates, and before migration 0047 they were
literally unrepresentable — `uniq_driver_units_open_unit` allowed one open row
per `unit_number`, full stop.

`decideUnitSync` offers seat 2 only when the observation says *team* **and**
exactly one seat is taken **and** that seat is not already 2. A full truck is
contested; there is no third seat, and the CHECK refuses one.

An existing composite person row ("A / B" as one driver) is **never split
automatically**.

## Two vocabularies, one translation

**Where the board's fleet comes from** changed in November 2026: the board
service writes it as a suffix of the truck (`021 CMP`), read by
`lib/board/truckSuffix.js`; the old spreadsheet wrote it inside the name, read
by `parseFleetLabel` below. See `dispatcher-board.md`.

`driver_profiles.driver_type` predates the Dispatcher Board and speaks
`owner` / `company_driver` / `lease`; the board speaks
`owner_operator` / `company` / `lease`. Both are kept — renaming a column a dozen
features read, to tidy a vocabulary, is a migration with no benefit — and
**`lib/drivers/fleetType.js` is the only place they are translated**, so they
cannot drift apart in a corner of the code.

`resolveDriverType({column, title})` decides which answer wins and **says which
it used**:

- a stored `driver_type` is somebody's decision and beats a title;
- a title is a string a dispatcher typed and may have edited since — the
  fallback for the rows nobody has decided, which is most of them;
- nothing to go on answers `{value: null, source: 'none'}`, never a default.

The `source` is returned because the difference matters at the call site: a
broadcast that changes who it reaches should be able to say whether it followed
a person's decision or a guess from a chat name.

**One deliberate behaviour change:** a title whose only parenthesised label is
*not* a fleet label (`Employee Feedback (Admin)`) now reads `unknown`, where the
old substring test returned `owner`. Treating an unrecognised label as the
unlabelled default would quietly file admin chats and mislabelled groups as owner
operators. A title with no parentheses at all — including one with a status word
appended, `... GOCHYYEV INACTIVE` — is still the owner-operator default.

## The owner is part of the truck, and the truck's fleet is not the driver's type (November 2026)

The owner's decisions of 5 November 2026, from the board ↔ Wenze ↔ Datatruck
comparison:

- **The name after a board number is the truck's OWNER, not its driver.**
  `1 ERNST` is driven by Jerome Joyner and `562 ERNST` by Ernst Brutus;
  `1 ERNST`, `1 ROGER` and `1 RUDOLPH` are three trucks; four owners each have
  an `001`. Under `(fleet, number, seat)` all three "1"s were one truck, so one
  driver held it and the others had no truck at all. Migration 0093 adds
  `driver_units.truck_owner` (NULL for a truck with no owner in its label —
  company, lease, lease-to-own) and replaces the open-truck index with one on
  `(fleet_type, unit_number, COALESCE(truck_owner, ''), seat)`. **Two known,
  different owners are two trucks; an unknown owner proves nothing** and still
  contests (`holderContests`, `lib/identity/personResolution.js`) — the same
  rule as an unknown fleet.
- **"By the truck an owner-operator, by the driver a company driver."** A driver
  hired by an owner drives an owner's truck as a company driver. The profile
  keeps the DRIVER's type in `driver_type` and may record the TRUCK beside it:
  `truck_fleet`, `truck_owner`, `truck_source` (`board` / `manual`).
  `lib/drivers/truckIdentity.js` `truckOfProfile` is the one reading: the
  truck's own fleet and owner when recorded, otherwise the driver's type (then
  the chat title) and no owner — so a profile the board has never named behaves
  exactly as before.
- **Where the truck comes from: the board** (`identity.truck_from_board`,
  `services/operations/checks/truckFromBoard.js`, auto since migration 0093, cap
  60 — the measured first pass: 46 of the board's 104 lines name an owner).
  Only for the same person on the same number — the profile's unit exactly
  equals the board line's, the names agree by the board match's strict rule, and
  exactly one present line does — and never over a truck a person set by hand.
  Nothing is filed when the profile already means that truck (a company driver
  in a COMP truck). The truck record then follows through
  `identity.unit_fleet_behind_profile`, which now compares fleet AND owner.
  A different number (John Elisee's chat says 01, the board 1 RUDOLPH) is a
  question for a person, not a copy. **A bare number is asked, not copied, when
  it contradicts the driver**: the board reads a number with no suffix as an
  owner-operator truck, so a company or lease driver on one is far more likely
  a lost suffix than an owner's truck (a hired driver's owner's truck carries
  the owner's name, `077 (Polvan)`). On 5 November 2026 `888` lost its `CMP` and
  the first pass copied owner-operator onto a company driver; that shape is now
  an approval-tier question that names the missing suffix, and only a person's
  Yes copies it.
- **Readers.** Every place that picks a truck's fleet reads `truckOfProfile`:
  the profile-save hook (`personResolver`), the stale-unit / contested /
  fleet-behind checks and their corrections, and the hand-over. The board match
  Home Time uses (`lib/identity/boardResolution.js` `holderInRowTruck`) rules
  out a holder in another owner's truck of the same number.

## A truck row's fleet follows the profile (November 2026)

A `driver_units` row copies its fleet from the profile's `driver_type` (or the
chat title) **when it is opened**. A person who later changes the profile —
Owner → Company driver — used to leave the row behind, and every reader that
compares fleets then saw a different truck. On 5 November 2026 production held
eleven: 077, 121, 124, 182, 322, 4135, 7777 and 25438 (Company driver,
recorded Owner-Operator — most in chats titled with the bare `( COMPANY )` the
title parser learned only in October) and 266116, 311 and 319 (Lease, recorded
Owner-Operator or Company). The Dispatcher Board could not recognise the ones
on it, because it matches a driver by truck **and** fleet.

The owner's decision of that day: **the row follows the profile.**
`identity.unit_fleet_behind_profile` (`services/operations/checks/identityLayer.js`)
finds an active chat whose person holds the profile's truck under another
fleet, and `identity.sync_unit_fleet` (`corrections/unitFleetActions.js`)
closes that row and opens a new one under the profile's fleet — history kept,
the revert reopens the old fleet. It does nothing when the profile cannot say
which fleet, when the person is on two active chats, or when somebody else
already holds that truck in the profile's fleet (two people in one truck is a
question for a person). Auto since migration 0092; cap 20, raised by 0093 to 60
(only while still 0092's own value) because every profile the board fills is
one more truck row to bring along, and a check over its cap applies nothing.

## The one destructive step in this programme

Migration 0047 **drops `uniq_driver_units_open_unit`** and replaces it with
`uniq_driver_units_open_fleet_unit_seat`.

The old index is strictly *stronger* — one open row per `unit_number` implies at
most one per `(fleet, unit, seat)` — so a collision is impossible unless somebody
removed it by hand. The migration **proves that rather than assuming it**: it
counts collisions first, and only then swaps. If there are any, the old index
stays and a `serious` finding
(`identity.unit_index_migration_blocked`) is filed naming the count. A migration
that took the fleet's uniqueness guarantee away on a bad assumption would be very
hard to notice and very expensive to undo.

`uniq_driver_units_open_person` is untouched: a person still drives one truck at
a time.

## What the backfill will not do

It fills `fleet_type` **only** from a `driver_type` that is actually set, through
the open person → group → profile chain. It parses no titles. Everything else
stays `unknown`.

It also requires the chain to **agree with itself**. A person can hold two open
group associations at once — that is `identity.person_on_two_active_groups`, a
condition production actually has — and their two profiles can disagree about
the driver type. A plain `UPDATE ... FROM` matches both rows and Postgres picks
one arbitrarily, so the chains are aggregated first and only an unambiguous one
is used. A disagreement stays `unknown` for a person to settle.

A backfill that guessed would bake a guess into the column that decides who is
allowed to share a truck number — and it would look, forever after, like a
recorded fact. A coin toss would be the same thing, without even the excuse of a
rule behind it.

## Lookups

`getOpenHoldersForUnit(unit)` returns **every** holder of a number, in every
fleet, in both seats, and has **no fleet filter on purpose**. Whether a holder in
another fleet is in the way is a *decision*, and `decideUnitSync` makes it the
same way every time; a SELECT that quietly dropped those rows would hide the
evidence the decision is made from.

`getOpenPersonForUnit` is deprecated for the reason this whole document exists:
it returns whichever row Postgres handed back first.

## Who reads the fleet now (A3b)

| Place | What changed |
|---|---|
| `services/identity/personResolver.js` | `syncUnitForPerson` takes every holder of a number and a fleet; `onProfileSaved` resolves the fleet from the profile's column, falling back to the chat title |
| `corrections/identityActions.js` `syncUnit` | locks and compares `fleet_type`, records it on the row it opens — a correction writing `unknown` would create a row that contests every same-numbered truck |
| `checks/identity.js` `checkDuplicateUnits` | buckets by `fleet:unit`, and falls back to the bare number the moment ONE claimant is unplaceable |
| `checks/identityLayer.js` | `unitsByNumber` returns a LIST (it silently kept only the last row before); `holdersInWay` decides who actually collides |
| `services/duplicateUnitCheckService.js` | same bucketing for its legacy reports. Its Samsara link needed no change — the exclusivity rule already refuses to link a vehicle claimed by more than one group |
| `services/driverStatusLookupService.js` (removed 2026-10-23 with `/status`, `retired-dispatch-eta.md`) | candidates carried `fleetType`, so a disambiguation list could say which truck each match was |
| `services/broadcastTargetService.js` | see below — the one user-visible change |
| admin | Lease Driver is selectable, labelled, and filterable; `driver_type` accepts `lease` through the API |

## The broadcast rule, and why it is shaped oddly

`isCompanyDriverGroup` looks redundant — it asks the strict parser *and* the old
permissive test. That is deliberate, and the asymmetry is the reason.

**A driver who quietly stops receiving company broadcasts produces no error and
no complaint** until something important is missed. So the rule is built so that
no *parsing* change can exclude a group the previous rule included:

- a recorded `driver_type` **decides** — this is the one thing that can newly
  exclude a group, and recording it is the point;
- otherwise the title decides **by either reading**, because `lib/board/` is
  strict (the Board always parenthesises its labels) while a Telegram title does
  not have to. `COMPANY DRIVERS` with no brackets is a company driver's chat,
  and since October 2026 so is a bare `( COMPANY )` — reading only the long form
  had typed 15 company drivers as owner operators. A RENAME now moves the
  recorded type too (`services/driverGroupTitleSync.js`).

`tests/broadcastCompanyDriverTarget.test.js` states that floor as a property, not
a list: for every title the old rule reached, the new rule must reach it too
unless somebody decided otherwise.

## Tests that guard this

- `tests/fleetType.test.js` — every label form, the typo, the two vocabularies,
  which answer wins and where it came from.
- `tests/personResolution.test.js` — same number different fleet is not a
  contest; `unknown` contests from either side; team takes seat 2; a full truck
  and a seat-2-only holder are contested.
- `tests/fleetTypeMigrationPg.test.js` **(required)** — the index swap, run
  twice, Company 001 beside Owner-Operator 001, the seat rules against the real
  index and CHECK, the backfill's refusal to guess or to coin-toss a
  disagreeing chain, and **the blocked branch**: seeded collisions leave the old
  index in force and file the finding.
- `tests/personResolverPg.test.js` — the fleet reaching a real assignment, a
  stored decision beating the title, and two fleets on one number coexisting.
- `tests/identityActionsPg.test.js` — the correction records the fleet and is
  not blocked by a holder in another one.
- `tests/truckIdentity.test.js`, `tests/truckFromBoardCheck.test.js` and
  `tests/truckOwnerIdentityPg.test.js` — two owners' trucks on one number
  coexist and one truck still cannot be held twice; the board's truck reaches
  the profile only for the same person on the same number; Wenze records
  `1 ERNST` and `1 ROGER` as two trucks by itself; a hired driver keeps his type
  while his truck becomes the owner's; the copy reverts.
- `tests/unitFleetSyncCheck.test.js` and `tests/identityActionsPg.test.js` — a
  truck row behind the profile's fleet is brought to it by the background loop,
  never onto a truck another driver holds in that fleet, and the revert reopens
  the old fleet.
- `tests/unitHandoverCheck.test.js` and `tests/fleetDecisionsPg.test.js` — a
  same-fleet holder with **no active chat** is a handover (`identity.unit_handover`,
  auto since migration 0078); a holder who still drives, or who comes back
  between the sweep and the apply, keeps the truck; the revert reopens it.
- `tests/broadcastCompanyDriverTarget.test.js` — nobody the old rule reached is
  dropped by a parsing change.
