# The Gross Grand Prix displays (`/dispatch`, `/dispatchteam`)

**Added:** 2026-10 · ported from the two race displays the owner approved
("Gross Race — Teams" and "Gross Race — Dispatchers"), standalone HTML files
that are **not** kept in this repository.

Two office-screen pages that race this week's gross: `/dispatchteam` races the
dispatch teams, `/dispatch` the dispatchers. Each has a **Full screen** button
that turns into **Exit full screen** while the page is in full screen, and back
again however full screen was left, Esc included (`useFullscreen.js` follows
`fullscreenchange`, not its own clicks).

## Where the numbers come from

- **Datatruck orders whose delivery APPOINTMENT falls in the race week**
  (`delivery_appointment_time`), read by `services/grossRace/feed.js` through
  `fetchOrdersByDeliveryAppointment` in `services/datatruckApiService.js` — GET
  only, with the app's own `DATATRUCK_API_TOKEN` / `DATATRUCK_COMPANY`.
- **The week** runs Monday 00:00 to the next Monday 00:00, America/Chicago. The
  countdown runs to that Monday, and loads delivered on it are counted too
  (`services/grossRace/week.js`, `countedUntil`).
- **Gross is `load_pay`.** A cancelled order, or one with no dispatcher or no
  date, does not count — and one that was counted is dropped when it turns into
  one of those.
- **A racer is `dispatcher__full_name`.** A name containing "team" (any case)
  races on `/dispatchteam`; every other name on `/dispatch`.
- **A truck is the trip's driver**, or both drivers of a team truck. The
  racer's target is **$15,000 per solo truck and $20,000 per team truck** it
  dispatched this week, summed, and the race is ranked by the share of that
  target reached (ties: gross, then name). `services/grossRace/standings.js`.

## What it costs Datatruck

Datatruck allows 20 requests a minute at 25 orders a page, and the rest of the
app spends the same allowance. So, as the design did:

- the whole week (about a dozen pages) is read at most every **20 minutes**;
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
- **The payload is names and race numbers:** dispatcher or team names, gross,
  loads, miles, target, share of target, rate per mile, and one light per truck
  (solo or team, target hit or not).
- **A driver's name is sent only once their truck has hit its weekly target**,
  which is exactly when the race announces it. The design held every driver's
  name in the page; a public endpoint must not.
- **A failed read reaches the screen as a fixed phrase** — "Datatruck rejected
  the token", "Datatruck rate limit reached, retrying", "Datatruck error (HTTP
  n)", "No connection to Datatruck" — never as the error itself, and the log
  line goes through `maskToken`. After a good read the screen keeps the last
  standings and its status line says *sync failed*; with nothing held it says
  **Offline**. A missing token or company reads "Datatruck is not connected".

## What the port left out of the design, on purpose

- **the Settings dialog** (token, company, field names, targets, week start,
  ranking): the token lives on the server, and the rest are fixed in code —
  Monday, Chicago, `load_pay`, ranked by share of target;
- **the demo mode** with invented racers;
- **driver names on trucks below target** (above).

Everything else is the design: the lanes, the lights, the podium, the race feed
(a gain, an overtake, a new leader, 100% of target, a driver on target) and the
banner. The feed comes from comparing one reading with the last, in the browser
(`admin/src/pages/grossRace/raceEvents.js`), so a screen opened mid-week starts
with an empty feed.

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
| `services/grossRace/standings.js` | orders → racers, targets, ranking, what the public payload holds (pure) |
| `services/grossRace/feed.js` | the held week, when to read, the failure phrases |
| `server/routes/grossRaceRoutes.js` | `GET /api/gross-race` |
| `admin/src/pages/grossRace/` | the page, its stylesheet and fonts (Archivo, SIL OFL), the race feed |

## Tests

```
node --test tests/grossRaceStandings.test.js tests/grossRaceFeed.test.js tests/grossRaceRoutes.test.js
node --test tests/api-surface.test.js   # /dispatch and /dispatchteam serve the shell; /dispatch/* → 410
npm test --prefix admin -- --run src/pages/grossRace
```
