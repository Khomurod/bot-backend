# The Gross Grand Prix displays (`/dispatch`, `/dispatchteam`)

**Added:** 2026-10 · ported from the two race displays the owner approved
("Gross Race — Teams" and "Gross Race — Dispatchers"), standalone HTML files
that are **not** kept in this repository.

Two office-screen pages that race this week's gross: `/dispatchteam` races the
dispatch teams, `/dispatch` the dispatchers. Each has a **Full screen** button
that turns into **Exit full screen** while the page is in full screen, and back
again however full screen was left, Esc included (`useFullscreen.js` follows
`fullscreenchange`, not its own clicks).

## Which loads count: Datatruck's own rule

**The race must show what Datatruck's driver board shows** (the owner, 12
October 2026). The rule below was found by reproducing that board from the API
and matches it to the cent on every row checked: Steven's Team $92,990 in 30
trips, Charles's Team $23,750, Franky's Team $21,642 and five more.

- **Every load except a booked or a cancelled one.** Booked is planned, not yet
  dispatched to a driver. Dispatched, in transit, delivered, invoiced and paid
  all count. Taking only the status *dispatched* would have shown Steven's
  Team $86,640, which is not what Datatruck shows.
- **In the week of its DEL date** (`delivery_time`), not its delivery
  appointment. The two can be days apart: a load with an appointment on 13
  October and a DEL date of 4 October is last week's on Datatruck's board.
- **The week is Monday 00:00 to the next Monday 00:00, America/Chicago** —
  Datatruck's "Oct 12 – Oct 18". The race design also counted the Monday after;
  that day belongs to the next week (`services/grossRace/week.js`).
- **Gross is `load_pay`.** A load that was counted is dropped when it turns
  booked or cancelled.
- Read by `services/grossRace/feed.js` through `fetchOrdersByDeliveryDate` in
  `services/datatruckApiService.js` — GET only, with the app's own
  `DATATRUCK_API_TOKEN` / `DATATRUCK_COMPANY`.

## Who a load counts for

- **Teams (`/dispatchteam`): the load's dispatcher** (`dispatcher__full_name`),
  and only names containing "team" race. A truck is the trip's driver, or both
  drivers of a team truck. A team's target is **$15,000 per solo truck and
  $20,000 per team truck** it ran this week, summed, and the race is ranked by
  the share of it reached (ties: gross, then name).
- **Dispatchers (`/dispatch`): whoever created the load** in Datatruck
  (`created_by__full_name`, the *Created By* column). **No target**: ranked by
  gross alone, the biggest first. A team account is not a dispatcher.
- **Not on the dispatchers' board:** one dispatcher who works for the company's
  other MC (`NOT_RACING` in `standings.js`, at the owner's request). Their
  loads still count for any team that ran them, as on Datatruck's board. No
  field in the API tells the other MC's people apart — they create loads under
  both MCs — so the list is by name.
- **Five to a screen, turning every ten seconds** on the dispatchers' board,
  round and round, each new screen flipping in like an airport departures
  board. The podium and the race feed always cover everybody. The teams fit on
  one screen.

`services/grossRace/standings.js`.

## What it costs Datatruck

Datatruck allows 20 requests a minute at 25 orders a page, and the rest of the
app spends the same allowance. So, as the design did:

- the whole week (about five pages) is read at most every **20 minutes**;
- in between, only the orders modified since the last read, re-reading 3
  minutes back because Datatruck's clock is not this server's — usually one page;
- **at most one read a minute** however many screens poll, one at a time, and
  **none while no screen is open**: a read starts only when a screen asks.

A screen never waits on Datatruck: it gets what the server holds and the read
finishes in the background. **Nothing touches the database.** The week lives in
memory, so after a restart the first screen to ask starts the read; the page
shows "Loading loads…" and asks every 5 seconds until the week is there, then
once a minute.

An incremental read only sees orders still dated inside the week, so a load
rescheduled out of it drops off at the next full read, within 20 minutes.

## Public, and what that obliges

`/dispatch`, `/dispatchteam` and `GET /api/gross-race?view=teams|dispatchers`
need no sign-in, like `/recruiters`: the screens hang in the office with nobody
signed in. Therefore:

- **The Datatruck token never reaches the page.** The design called Datatruck
  from the browser with the company's token written into the HTML. The port
  reads on the server, and the page only ever calls `/api/gross-race`. Never
  add a token, a Datatruck URL or a field to type one into the page.
- **The payload is names and race numbers:** team or dispatcher names, gross,
  loads, miles and rate per mile; for teams also the target, the share of it,
  and one light per truck (solo or team, target hit or not).
- **A driver's name is sent only once their truck has hit its weekly target**,
  and only on the teams' board, which is exactly when the race announces it.
  The dispatchers' board names no driver at all. The design held every
  driver's name in the page; a public endpoint must not.
- **A failed read reaches the screen as a fixed phrase** — "Datatruck rejected
  the token", "Datatruck rate limit reached, retrying", "Datatruck error (HTTP
  n)", "No connection to Datatruck" — never as the error itself, and the log
  line goes through `maskToken`. After a good read the screen keeps the last
  standings and its status line says *sync failed*; with nothing held it says
  **Offline**. A missing token or company reads "Datatruck is not connected".

## What the port left out of the design, on purpose

- **the Settings dialog** (token, company, field names, targets, week start,
  ranking): the token lives on the server, and the rest are fixed in code
  (above);
- **the demo mode** with invented racers;
- **driver names on trucks below target** (above).

Everything else is the design: the lanes, the lights, the podium, the race feed
(a gain, an overtake, a new leader; on the teams' board also 100% of target and
a driver on target) and the banner. The feed comes from comparing one reading with the last, in the browser
(`admin/src/pages/grossRace/raceEvents.js`), so a screen opened mid-week starts
with an empty feed — and when the week turns over, a screen left open clears
last week's feed, flashes and banner: a new week is a new race.

## `/dispatch` is a new page, not the Dispatch Center

`/dispatch` was the retired Dispatch Center's address and answered 410
([`retired-dispatch-center.md`](retired-dispatch-center.md)). Since October 2026
the bare path serves the shell and the dispatchers' race; **`/dispatch/*` still
answers 410**, so a held deep link into the old page never reaches the shell.
`admin/src/App.jsx` maps both paths from `window.location.pathname` before any
sign-in check, the way it maps `/recruiters`.

## Files

| | |
|---|---|
| `services/grossRace/week.js` | the race week (pure) |
| `services/grossRace/standings.js` | which loads count, who they count for, targets, ranking, what the public payload holds (pure) |
| `services/grossRace/feed.js` | the held week, when to read, the failure phrases |
| `server/routes/grossRaceRoutes.js` | `GET /api/gross-race` |
| `admin/src/pages/grossRace/` | the page, its stylesheet and fonts (Archivo, SIL OFL), the race feed |

## Tests

```
node --test tests/grossRaceStandings.test.js tests/grossRaceFeed.test.js tests/grossRaceRoutes.test.js
node --test tests/api-surface.test.js   # /dispatch and /dispatchteam serve the shell; /dispatch/* → 410
npm test --prefix admin -- --run src/pages/grossRace
```
