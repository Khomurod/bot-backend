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

A truck's name is `(fleet_type, unit_number, seat)`. Nothing less identifies one.

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

A backfill that guessed would bake a guess into the column that decides who is
allowed to share a truck number — and it would look, forever after, like a
recorded fact.

## Lookups

`getOpenHoldersForUnit(unit)` returns **every** holder of a number, in every
fleet, in both seats, and has **no fleet filter on purpose**. Whether a holder in
another fleet is in the way is a *decision*, and `decideUnitSync` makes it the
same way every time; a SELECT that quietly dropped those rows would hide the
evidence the decision is made from.

`getOpenPersonForUnit` is deprecated for the reason this whole document exists:
it returns whichever row Postgres handed back first.

## Tests that guard this

- `tests/fleetType.test.js` — every label form, the typo, the two vocabularies,
  which answer wins and where it came from.
- `tests/personResolution.test.js` — same number different fleet is not a
  contest; `unknown` contests from either side; team takes seat 2; a full truck
  and a seat-2-only holder are contested.
- `tests/fleetTypeMigrationPg.test.js` **(required)** — the index swap, run
  twice, Company 001 beside Owner-Operator 001, the seat rules against the real
  index and CHECK, the backfill's refusal to guess, and **the blocked branch**:
  seeded collisions leave the old index in force and file the finding.
