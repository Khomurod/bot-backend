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

## The test endpoint answers with counts

`POST /api/settings/dispatch-board/test` returns row counts, fleet and status
histograms, team counts — and the **names** of any column the parser does not
recognise. Never rows. A settings screen has no business rendering driver
names, phone numbers or trailer numbers to answer "did it connect, and does it
look right", and the unknown-column names are how the real shape is learned
without showing the data in it.

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

## What is not built yet

Polling, the snapshot table, linking a Board row to a person, and the
contradiction checks. This stage ships the connection, the parser and the test
button; `enabled` defaults to FALSE and nothing is read until an administrator
saves a URL and a token.
