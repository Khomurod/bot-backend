# The Dispatcher Board

**Read this before changing anything that reads the board, compares a truck
number, or decides which fleet a driver belongs to.**

The Dispatcher Board is an external Google Apps Script web app in front of the
dispatchers' own spreadsheet. It is not part of this application and nobody here
controls its shape.

## What it is for now: Home Time's home-in and home-out

Since October 2026 the Board has **one reader**: the home-time board watch
(`services/homeTime/boardPresenceWatch.js`, background service
`home_time_board_presence`). When dispatch marks a driver `HOME` or `VACATION`
and it holds, Wenze opens a home stay; when the line moves back into the
dispatch pool, Wenze closes it. The rule is `lib/homeTime/boardPresence.js`, and
[`home-time-evidence.md`](home-time-evidence.md) owns it. In production over the
60 days before the change, the Board opened 40 of about 104 home stays and
closed 34 of about 92.

Everything else that used to be built on the Board is gone — see
[What was removed](#what-was-removed-in-october-2026) at the end.

## Who is the authority on what

| Question | Authority | Why |
|---|---|---|
| What dispatch says a driver is doing **right now** (the status word) | **the Board** | It is what the dispatchers actually work from, and they update it all day |
| Whether a driver is at home | **Home Time** | The Board's status is one source; the driver's own message outranks a fresh disagreement — see `home-time-evidence.md` |
| Who a person permanently **is**, and their truck | **Wenze** (`driver_people` and its associations) | A truck changes; a person does not. The Board never changes either |
| Where the truck physically is, hours of service, load documents | Samsara / ELD / Datatruck | Supporting evidence, never identity |
| Talking to a driver | Telegram | A channel. Never an authority on anything |

A Board status that disagrees with Home Time for half a day is a **finding**
(`home_time.board_disagrees_with_state`, filed by the watch), not a correction.

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

A misspelling is accepted **and said so**: the stored row carries
`fleet_label_normalised`, because silently normalising it would hide a column
somebody is editing by hand. (Until October 2026 a check filed it as a finding;
the column stays.)

## A team row is two people

`is_team`, or a ` / ` in the name. The two signals are allowed to disagree and a
disagreement is recorded (`team_flag_mismatch`) rather than resolved — the flag
says the dispatcher meant a team, the separator says they typed one, and which
is right is a human question. **A composite person is never split
automatically.**

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
`problems`. It **never throws** — the poller that reads the Board is how Home
Time learns that dispatch marked a driver home, and a renamed column must degrade
that, not stop it.

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

Every failure path returns `{ error }` rather than throwing — the settings read,
the fetch, the parse, the store — and each one leaves the snapshot exactly as it
was. `tests/dispatchBoardPoller.test.js` asserts it on every one of them.

**What may retire a row is an answer with something IDENTIFIABLE in it**, which
is not the same as an answer with rows in it. Three different answers reach an
empty keep-list without the board having emptied:

- `{"rows": []}` — an Apps Script that hit its own error or lost its sheet still
  answers 200.
- `{"rows": [{}, {}]}` — both identifying column names were renamed. The parser
  keeps the rows and reports them, so the *count* is not zero, but every
  `row_key` is null and nulls are filtered out of the keep-list. Counting rows
  would have missed this.
- Rows naming a truck and nobody. `driver_name_raw` is `NOT NULL`, so they
  cannot be stored and cannot hold their place either — and before the guard,
  one blank driver cell made every pass fail at the same position, so no later
  row ever refreshed.

So the keep-list is exactly what was **stored**, never what was read, and a pass
with nothing storable in it is reported and changes nothing. If the board really
has emptied, its rows stay present with a `last_seen_at` that stops moving,
which is visible and reversible. The opposite mistake is not.

**A pass is one transaction.** `applyBoardPass` opens a client, upserts every
row and applies the absences inside `BEGIN`/`COMMIT`. Without it, `query`
autocommits: a pass that wrote forty rows and failed on the forty-first left the
snapshot half-new, reported the pass as failed, and stayed mixed until some later
pass succeeded — indefinitely, if the bad row kept coming back. "A failed pass
leaves the snapshot exactly as it was" has to be true of a pass that failed
*halfway*, which is the only kind that matters.

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

**Two lines that reduce to one key collapse into one stored row, and the row
says so** (`key_collision`). Wenze does not invent a key to separate them: a
made-up identity would not survive the sheet being sorted, so the same driver
would appear to change identity every time somebody reordered the board. It
records that it cannot tell them apart. Nothing reports it any more — the
check that did (`board.duplicate_row_key`) went in October 2026 — so the
column is the only trace, and the home-time watch treats two rows about one
person as no answer at all.

## The Feed card reads Wenze, not the board

`GET /api/settings/dispatch-board/feed` answers from `dispatch_board_rows`, and
never contacts the board. "The board has 102 rows" and "Wenze knows about 102
rows" are different claims, and only the second is what Home Time answers from.
Counts only — no name, no phone, no truck — and the status histogram is grouped
rather than enumerated, so a word dispatch invents appears instead of vanishing
into "other". Its "Matched to a person" count is rows whose `person_id` is set;
nothing sets that column any more (see below), so it only counts links made
before October 2026.

## Which person a row is about — decided at read time

`services/dispatchBoard/rowPeople.js` answers it for the home-time watch, on
every pass, and **writes nothing**. It indexes the person layer once
(`indexLayer`, `holdersFor` — moved here from the deleted
`checks/boardLink.js`) and asks the pure rule in
`lib/identity/boardResolution.js` about each present row.

**The rule is unchanged, and it refuses more often than it answers.** Putting a
row on the wrong person would move that person's home-time clock and their
bonus. Two independent facts must agree: the truck (by its EXACT spelling) and
the name (strictly). There are deliberately **two name tests**:

| | may | accepts |
|---|---|---|
| `namesAgreeStrictly` (`boardResolution.js`) | **act** | exact after normalisation, or every word of the shorter name inside the longer, with at least two words |
| `driverNamesMatch` (`lib/drivers/`) | only **suggest** | a shared surname, two shared 3-letter tokens — two brothers match |

Only `link` (both facts agree) or a link somebody already made that still fits
counts as settled. A name-only match, a digits-only truck match, two holders, or
a row whose linked person no longer holds the truck all come back unresolved, and
the watch leaves that driver alone. **Two rows about one person disqualify
both.** A team row is two people: `decideTeamBoardLink` asks about each member
separately and refuses both when the two names resolve to one stored person.

## What a board status MEANS

`lib/board/statusSemantics.js`, and it is the one place to change it:

| | statuses | |
|---|---|---|
| **home** | `HOME`, `VACATION` | the driver is not working |
| **working** | `DISPATCHED`, `ENROUTE` | the driver is on the road right now |
| **neutral** | `READY`, `RESERVED`, `REST`, `SHOP` | **neither may be concluded** |

`boardEndsHomeStay` (READY, RESERVED, DISPATCHED, ENROUTE) is a separate
question, asked only of a driver Wenze already has at home. REST and SHOP end
nothing: a driver can rest at home, and a truck can sit in a shop while its
driver is on their couch. An unknown status is never a conclusion. These
defaults are the owner's to confirm.

## What was removed in October 2026

The Board used to be "the authority on today's assignment" for the whole
application. With the driver-raise review gone
([`retired-driver-raise.md`](retired-driver-raise.md)) nothing needed that, and
everything built on it was removed:

| Removed | Was |
|---|---|
| `services/operations/checks/board.js` | seven findings about the spreadsheet itself (`board.unknown_fleet_label`, `board.fleet_label_typo`, `board.unknown_status`, `board.team_flag_mismatch`, `board.truck_on_multiple_rows`, `board.duplicate_row_key`, `board.row_vanished`) |
| `services/operations/checks/boardLink.js` | linking a row to a person: `board.person_link`, `_suggested`, `_conflict`, `_ambiguous`, `board.person_unmatched`, `board.team_person_needs_split` |
| `services/operations/corrections/boardActions.js` | the `board.link_person` correction that wrote `person_id` / `link_source` / `link_confidence`. It was the **only** action armed for automatic rollback in `services/decisions/verifyPass.js`; now no action is, and `autoRevert` is false everywhere |
| The Board's say on the stale-unit sync (`checks/identityLayer.js`) | agreeing raised `identity.stale_unit_assignment` from 90 to 95; disagreeing suppressed it and filed `board.truck_disagrees_with_profile`. Confidence is now fixed at 90 |
| Board-vs-Home-Time contradictions (`lib/drivers/context.js`, `database/driverContext.js` `readBoard`, `BOARD_FRESH_HOURS`) | `context.board_home_while_road`, `context.wenze_home_while_board_working`. The watch's own `home_time.board_disagrees_with_state` is the one remaining disagreement |
| Board rows in the consistency snapshot (`snapshot/loaders.js`, `database/dispatchBoard.js getBoardRowsForSnapshot`) | the checks above were their only readers |
| Board entries in `lib/control/{askable,fingerprint,priority}.js` | Wenze no longer asks the owner about board findings in Telegram |
| The board badge on Groups (`database/driverGroupDirectory.js`, now `withOpenFindings` over `identity.` / `home_time.` prefixes), the board block on the person identity panel and in `getPersonIdentity` / `summariseIdentityCoverage` (`database/driverPeople/lookups.js`), the "Board rows matched" tile on Operations → Identity | |

Every removed check key is listed in `services/operations/checks/retired.js`, a
check module that finds nothing, so a sweep resolves any finding still open
under it. `dispatch_board_rows.person_id`, `link_source` and `link_confidence`
stay as columns; links already made are still honoured by the read-time rule,
and nothing writes new ones.

**Kept:** `services/dispatchBoard/{client,poller,rowPeople}.js`,
`database/dispatchBoard.js`, `database/dispatchBoardSettings.js`,
`server/routes/settings/dispatchBoardRoutes.js`, `lib/board/*`,
`lib/identity/boardResolution.js`, the home-time pair above, Settings →
Dispatcher Board (feed settings, the Feed card, and the automatic ETA updates
card that lives on the same tab), and the background services
`dispatch_board_poll` and `home_time_board_presence` — both slowed, never paused,
in economy mode ([`economy-mode.md`](economy-mode.md)).
