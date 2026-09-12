# The Dispatcher Board

**Read this before changing anything that reads the board, compares a truck
number, or decides which fleet a driver belongs to.**

The Dispatcher Board is an external Google Apps Script web app in front of the
dispatchers' own spreadsheet. It is not part of this application and nobody here
controls its shape.

## Who is the authority on what

This is the rule the whole integration exists to express. Nothing may quietly
invert it.

| Question | Authority | Why |
|---|---|---|
| Which truck, trailer, status, ETA, dispatcher, and whether it is a team — **right now** | **the Board** | It is what the dispatchers actually work from, and they update it all day |
| Who a person permanently **is**, and everything that has happened to them | **Wenze** (`driver_people` and its associations) | A truck changes; a person does not |
| Where the truck physically is, hours of service, load documents | Samsara / ELD / Datatruck | Supporting evidence, never identity |
| Talking to a driver | Telegram | A channel. Never an authority on anything |

A disagreement between the Board and Wenze is a **finding**, not a correction.
Wenze does not pick a side on "which truck is this driver in" — it says the two
systems disagree and lets a person answer.

## A truck number is not globally unique

Three fleets number their trucks independently. **Company 001, Owner-Operator
001 and Lease 001 are three different trucks.** Production already carries ten
unit numbers on more than one active driver group, `001` on four of them.

So the identity of a truck is `(fleet_type, unit_number)`, and there are two
comparison keys (`lib/board/truck.js`):

| Key | What it is | What it may do |
|---|---|---|
| `exact` | prefix stripped, **leading zeros and letter suffixes kept** | strong enough to justify a write |
| `digitsOnly` | what `samsaraLocationService.normalizeUnitNumber` produces | generate candidates; **never act** |

`unknown` is a real fleet type and it **never wins a match**. A row Wenze cannot
place is a question, never a merge.

## Reading the fleet label

The Board writes the fleet inside the driver's name. `lib/drivers/fleetType.js`
is the only place that reads it:

| On the Board | Fleet type |
|---|---|
| `(COMPANY DRIVER)`, `(COMPANY DRIVERS)`, `(COMPANY)` | `company` |
| `(LEASE DRIVER)`, `(LEASE DRIVERS)`, `(LEASE)` | `lease` |
| no parenthesised label at all | `owner_operator` — the Board's own convention |
| `(COMPNAY DRIVER)` | `company`, and the row is marked `normalised: true` |
| anything else | `unknown` |

A misspelling is accepted **and said so**. "We guessed" is a fact the finding
has to carry; silently normalising it would hide a column somebody is editing
by hand.

## A team row is two people

`is_team`, or a ` / ` in the name. The two signals are allowed to disagree and a
disagreement is reported rather than resolved — the flag says the dispatcher
meant a team, the separator says they typed one, and which is right is a human
question. **A composite person is never split automatically.**

## The token travels in the query string

That is the Apps Script's design and cannot be changed from here. Three
consequences, all enforced in code:

1. **Every message leaves through `lib/security/redactUrls.stripUrls`** before
   it reaches a log, an API response, a finding or `last_error`. Not just the
   token — the host too. `dispatch_board_settings.last_error` carries a column
   comment saying it must never contain a URL.
2. **Exactly one redirect is followed, by hand, and the token is not
   re-attached to it.** An Apps Script `/exec` answers 302 to
   `script.googleusercontent.com`, whose signed URL carries its own
   authorisation. `redirect: 'follow'` would chase a chain to anywhere while
   holding a credential.
3. **The token is write-only from the admin.** The read returns a masked
   last-4; `/test` proves a candidate from the request body so a connection can
   be verified before it is saved, and never echoes it.
4. **A credential pasted inside the URL is taken out of it.** The Board's own
   link carries `?token=…`, so "paste the link" means "paste the credential";
   left as typed it would sit in plaintext in a column the admin read returns
   verbatim. `lib/security/redactUrls.splitCredentialsFromUrl` strips it on
   save, and a `token` found there is ADOPTED into the encrypted field — the
   administrator plainly meant it as the credential. Any other
   credential-shaped parameter is stripped and not adopted: we do not know what
   it was for, and guessing is how a secret lands in the wrong slot.
5. **The stored token belongs to the stored address.** Testing a NEW address
   requires its own token. Combining a candidate URL with the saved credential
   would hand the write-only token to whatever somebody typed into the form.

## The test endpoint answers with counts

`POST /api/settings/dispatch-board/test` returns row counts, fleet and status
histograms, team counts — and the **names** of any column the parser does not
recognise. Never rows. A settings screen has no business rendering driver
names, phone numbers or trailer numbers to answer "did it connect, and does it
look right", and the unknown-column names are how the real shape is learned
without showing the data in it.

## A failure is never rendered as "not configured"

`getSettingsRow` does not catch. A database that cannot be reached and a
configuration nobody has entered are opposite facts, and swallowing the first
turns it into the second — the admin read answers 200 with "off and
unconfigured", and the 30-second cache goes on saying so after the database has
come back. `APP_BRIEF.md` §9 states the rule; the route turns the throw into a
500 rather than a lie.

## The parser bends; it never guesses

`lib/board/parse.js` looks for the row array under several keys, reads each
field through a list of aliases, and records anything it could not place in
`problems`. It **never throws** — the poller that reads the Board is how Wenze
learns today's assignment, and a renamed column must degrade that, not stop it.

## Naming

`tests/removedFeaturesStayRemoved.test.js` bans import paths containing
`trailer`, `sosAssessment`, `/sos` and `qbq`, and baseline tables matching
`^(trailer|sos_|qbq_|fleet_)`. So the Board's trailer field is the **column**
`board_trailer`, the fleet column is `fleet_type` (a column is fine), and the
pure modules live in `lib/board/` — never `lib/fleet/`.

## The snapshot is written by exactly one thing

`services/dispatchBoard/poller.js` is the only writer of
`dispatch_board_rows`. Every five minutes (60–3600 s, configurable) it fetches,
parses, upserts and marks the rows it did not see as absent — and does nothing
else. It decides nothing, it sends nothing, and it never marks a row absent on a
pass that failed:

> "We could not read the board" and "nobody is on the board" are opposite
> facts, and only the second one may retire a row.

Four failure paths return `{ error }` rather than throwing — the settings read,
the fetch, the parse, the store — and each one leaves the snapshot exactly as
it was. `tests/dispatchBoardPoller.test.js` asserts `markAbsent` was not called
on every one of them.

A **well-formed answer carrying zero rows** is treated the same way. `markAbsent([])`
retires every row by design — that is what an empty board means — but an Apps
Script that hits its own error or loses its sheet answers `{"rows": []}` with a
200, and acting on that would retire the fleet's whole assignment history on one
bad afternoon. A zero-row pass is reported and changes nothing; if the board
really has emptied, its rows stay present with a `last_seen_at` that stops
moving, which is visible and reversible. The opposite mistake is not.

`enabled = FALSE` and "no address and token saved" return `{ blocked }`, which
the run ledger renders as *waiting on somebody* rather than as a failure. The
catalogue entry is `dispatch_board_poll` (integration, critical, configurable),
so `/api/health` carries it from the first boot after the feature ships.

## A row never disappears; it stops being present

`row_key` is `normalizedTruck|normalizedPerson` because the Board has no stable
row id — a spreadsheet row number changes when somebody sorts the sheet. A row
that vanishes is set `present = false` and kept: `first_seen_at` /
`last_seen_at` / `last_changed_at` are the only history of an assignment the
Board itself does not keep.

`last_changed_at` moves only when a MEANINGFUL column differs — not on every
pass — so "this driver's assignment changed at 11:04" stays true.

## What the board checks report, and what they never do

`services/operations/checks/board.js` files six findings, and **every one of
them is `tier: 'warning'` with `proposedChange: null`**. Nothing in a
spreadsheet read is evidence about which of two disagreeing records is right, so
a board finding is always a question for a person:

| Key | Severity | What it says |
|---|---|---|
| `board.unknown_fleet_label` | warning | a label Wenze cannot place — the row is silently inert downstream, which is why this is not `info` |
| `board.fleet_label_typo` | info | a label read *through* a misspelling, so nobody later wonders what else is interpreted |
| `board.unknown_status` | info | a status outside the board's own vocabulary |
| `board.team_flag_mismatch` | warning | the team column and the written name disagree, so Wenze cannot tell how many humans the row is about |
| `board.truck_on_multiple_rows` | warning | one truck, two rows, **within one fleet** |
| `board.row_vanished` | info | a driver left the board, for seven days only |

`board.truck_on_multiple_rows` buckets on `fleetType|truck`, never on the bare
number. Company 001, Owner-Operator 001 and Lease 001 are three trucks, and a
check that reported all three would train an operator to ignore the page inside
a week. A row whose fleet is `unknown` is compared against *every* bucket
sharing its number — "we cannot tell them apart" is exactly when a person
should look.

## The Feed card reads Wenze, not the board

`GET /api/settings/dispatch-board/feed` answers from `dispatch_board_rows`, and
never contacts the board. "The board has 102 rows" and "Wenze knows about 102
rows" are different claims, and only the second is what every other feature will
answer from. Counts only — no name, no phone, no truck — and the status
histogram is grouped rather than enumerated, so a word dispatch invents appears
instead of vanishing into "other".

## What is not built yet

Linking a Board row to a person (`person_id`, `link_source`, `link_confidence`
are created and unused), and the contradiction checks between the Board and
Wenze. Both are later stages with their own evidence rules: a poller that also
decided would put "the spreadsheet has a typo" and "the two systems disagree
about a driver" behind one switch.
