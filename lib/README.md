# `lib/` — pure helpers and constants

The bottom of the dependency chain in `CLAUDE.md` → Module design:

```
routes/controllers → service façade/orchestrators → focused domain services
  → database and external integrations → pure helpers/constants
```

This directory is that last link. **Every module here is pure**: no database
access, no HTTP, no Telegram, no filesystem, no shared mutable state. That is
what makes it safe for any layer — including `database/` — to depend on.

## Why it exists

Nine of these modules used to live under `services/`, a layer *above* the database.
Nineteen `database/**` modules therefore had to reach upward to use them, which
inverted the stated dependency direction and made the data layer non-testable in
isolation. Moving them fixed the direction rather than papering over it with a
lazy `require()`.

## The rule for adding something here

A module belongs in `lib/` only if all of these hold:

1. it performs **no I/O of any kind** and holds no mutable state;
2. it is used by **more than one layer** (typically a database module and a
   service or route);
3. it has a real **domain** to sit in — `lib/` is organized by subject, not by
   shape.

If it does I/O, it is a service. If only one caller needs it, keep it next to
that caller. **Do not add a `lib/utils/`, `lib/helpers/` or `lib/common/`** —
a module with no domain to name is a sign the boundary is wrong, not that it
needs a drawer.

## Contents

| Module | What it is |
|---|---|
| `security/facebookCrypto.js` | Symmetric encrypt/decrypt + masking for stored secrets. Named for its first caller, but used for RingCentral, ELD and GMaps credentials too. |
| `rbac/roleKeys.js` | Canonical role keys and the super-admin identity check. |
| `drivers/driverGroupTitle.js` | Parsing a driver group's Telegram title into name / unit / type. |
| `drivers/driverProfileParse.js` | Driver type inference and the inactive-group verdict. |
| `telegram/telegramUsername.js` | Normalizing a Telegram `@username` and numeric user id. |
| `telegram/chatId.js` | Parsing a Telegram chat id, and `signFlipCandidate` — the value to look up when asking "did they drop the minus sign?". A group id is negative; `5052301861` for a chat that is really `-5052301861` is well-formed and points at nothing, which is how every internal home-time alert failed silently for months. |
| `telegram/telegramErrors.js` | `cleanTelegramError` — a Telegram rejection as text safe to show an admin. Telegraf hangs the bot token off some error shapes, and the screens that surface these errors are the ones that configure credentials. |
| `phone/e164.js` | `toE164` (a number you can SEND from — RingCentral rejects anything else) and `phoneKey` / `sameNumber` (comparing two spellings). Two jobs, deliberately side by side: confusing them is what texted every lead from the shared number. |
| `routeControl/routeControlConstants.js` | Route Control thresholds and label tables. |
| `geo/distance.js` | Great-circle distance — the single implementation. `haversineMiles` is `haversineMeters` converted, not a second formula, because four consumers answer "is the truck there yet" from it: route completion, tracking start, fuel-stop proximity and ETA remaining distance. |
| `board/parse.js` | Reads the Dispatcher Board's JSON tolerantly — the row array under several keys, each field through a list of aliases — and records what it could not place in `problems` (unrecognised columns by NAME only). Never throws: a renamed column must degrade the poller, not stop it. |
| `board/truck.js` | The two truck comparison keys. `exact` keeps leading zeros and letter suffixes and is the only one strong enough to act on; `digitsOnly` matches what the location service does and may only suggest. Ten unit numbers are on more than one active group today. |
| `board/rowKey.js` | A stable name for a Board row — truck plus person, not the spreadsheet position, which renumbers the moment somebody inserts a line. A team is named by both people, sorted. |
| `drivers/fleetType.js` | `company` / `lease` / `owner_operator` / `unknown`, and reading the label out of a Board driver name. Company 001, Owner-Operator 001 and Lease 001 are three trucks; `unknown` never wins a match. |
| `security/redactUrls.js` | Takes every URL and stray credential pair out of a sentence before it is logged, stored or returned. The Dispatcher Board authenticates by query string, so an error message that quotes the request is a leaked token. |
| `database/timestampValue.js` | Turns anything an external system sent into a value a `timestamptz` parameter accepts, or **null**. Postgres treats a string it cannot read as an ERROR, not a null, so a Datatruck `pickup_time` of `TBD` aborted the statement and the whole background pass behind it. The opposite contract to `services/liveLocations/shaping.toIso`, which keeps unreadable text for DISPLAY — the two must not be swapped. A day that does not exist is refused arithmetically (`Date.parse('2026-02-30')` answers 2 March), and a null it returns is never a fresh reading: see the sighting counter in `database/homeTime/returnWatch.js`. `toNumericValue` beside it does the same for numbers, where the trap hides better: NaN is accepted by a `double precision` column and refused by an `integer` one, so a bad reading stores silently and poisons the next pass that reads it back. |
| `database/failureClassification.js` | Which kind of database failure an error is — unreachable, timed out, out of allowance, permission — as a code + status + human sentence. Used by the query boundary (`database/pool.js`), the route failure helper and the tests; an ordinary SQL error deliberately classifies as nothing. |
