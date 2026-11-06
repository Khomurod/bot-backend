# The Gross Grand Prix displays (`/dispatch`, `/dispatchteam`)

**Added:** 2026-10 · ported from the two race displays the owner approved
("Gross Race — Teams" and "Gross Race — Dispatchers"), standalone HTML files
that are **not** kept in this repository.

Two office-screen pages that race this week's gross: `/dispatchteam` races the
dispatch teams, `/dispatch` the dispatchers. Each has a **Full screen** button
that turns into **Exit full screen** while the page is in full screen, and back
again however full screen was left, Esc included (`useFullscreen.js` follows
`fullscreenchange`, not its own clicks).

## Which loads count

**A load counts in the week of its PU date** (the owner, 16 October 2026):

- its PU date (`pickup_time`) falls between **Monday 00:00 and the next
  Monday 00:00, America/Chicago** (`services/grossRace/week.js`;
  `countsInWeek` in `standings.js`). When it was created and when it delivers
  do not matter. Dates, not statuses: a load picked up on Friday counts from
  the moment it is dispatched, and stays in that week if it delivers on
  Monday;
- and it is **dispatched**: not booked (planned, no driver yet) and not
  cancelled. Datatruck has no "dispatched at" date, so the status is the test;
- **gross is `load_pay`.** A load that was counted is dropped when it turns
  booked or cancelled.

**Every dispatched load counts in exactly one week**, the week it was picked
up. The totals therefore differ from Datatruck's driver board, which files a
load under its DEL date: a load picked up Sunday and delivered Monday is in
this race's earlier week and the board's later one.

**History.** 12–16 October 2026 a load counted only when it was created,
picked up AND delivered in the same week. That left a load in no week at all
whenever it crossed a Sunday night — started before Monday, or delivered after
Sunday (one dispatcher's $5,400 load, picked up Friday 16 October and
delivered Monday 19 October, would never have counted). The owner replaced it
with the PU date on 16 October. Before 12 October the race matched Datatruck's
board, by DEL date, to the cent.

**The rule is printed on both boards**, under the header: the week's dates,
what counts and what does not (`RaceRules.jsx`). Change the rule and that text
together.

The week's orders are read by PU date through `fetchOrdersByPickupDate` in
`services/datatruckApiService.js` — GET only, with the app's own
`DATATRUCK_API_TOKEN` / `DATATRUCK_COMPANY` — from 12 hours before Monday, so
a PU date typed without a time (stored as midnight UTC, Sunday evening in
Chicago) is read and then placed on its day by `stopDate()`.

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
app spends the same allowance (one of those, since November 2026, is the
Board ↔ Wenze ↔ Datatruck comparison: a driver list and a week of orders, only
when a person presses Compare, at most once per ten minutes, and the same read
once a day for the daily check —
[`dispatcher-board.md`](dispatcher-board.md)). So, as the design did:

- the whole week (about five pages) is read at most every **20 minutes**;
- in between, only the orders modified since the last read, re-reading 3
  minutes back because Datatruck's clock is not this server's — usually one page;
- **at most one read a minute** however many screens poll, one at a time, and
  **none while no screen is open**: a read starts only when a screen asks.

A screen never waits on Datatruck: it gets what the server holds and the read
finishes in the background. **Nothing touches the database.** The week lives in
memory, so after a restart the first screen to ask starts the read; the page
shows "Loading loads…" and asks every 5 seconds until the week is there, then
every 30 seconds, so a load is on screen within about a minute of Datatruck
having it.

An incremental read only sees orders still picked up inside the week, so a
load whose PU date moves out of it drops off at the next full read, within 20
minutes.

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
- **Birthdays are the one exception, by the owner's decision (6 November
  2026):** for a day after the Telegram post, `birthdays` names the employee
  (full first name and American name, and the card that went to the employee
  group, served by `GET /api/gross-race/birthday-card/:key`) or the driver (the
  name from their chat's title and the truck number on their profile). Never a
  Telegram account, a date of birth or a phone number; the card route answers
  404 for anything not on the boards today. See "Birthdays on the boards".
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

## The 4 PM celebration

**Every day at 4:00 PM Chicago time, each screen celebrates its leader for
twelve seconds** (the owner, 12 October 2026). On `/dispatch` that is the
dispatcher with the most gross. On `/dispatchteam` it is the team leading the
race, ranked by share of target, the board's own order. The screen shows the
name over a realistic 3D car the camera circles, with the line *"You took
first place! Keep it up, and one day you'll buy a great new car."* There is no
celebration while nobody has any gross.

- **Each screen keeps its own clock** (`celebration/celebrationTime.js`): the
  celebration is "4:00 PM, the whole minute, once per Chicago day". A screen
  that is off or asleep at 4 PM does not catch up.
- **The 3D is never loaded with the board.** three.js (~190 KB gzipped) and the
  car (3.2 MB) are fetched in the three minutes before 4 PM. The WebGL scene is
  built for the celebration and torn down after it (`carScene.js`). A screen
  without WebGL, or one where the car fails to load, shows the same words with
  a trophy.
- **three.js is why the admin build sets its own heap limit.** Render applies
  the service's `NODE_OPTIONS=--max-old-space-size=256`, meant for the server,
  to the build as well. Bundling three.js needs more than that: `vite build`
  died with "JavaScript heap out of memory" (exit 134), and every deploy failed
  while production stayed on the previous build. `admin/package.json` runs vite
  with `--max-old-space-size=512`, which beats `NODE_OPTIONS`, and
  `tests/adminBuildHeap.test.js` keeps it there.
- **`?celebrate` in the address shows it at once**, e.g.
  `/dispatchteam?celebrate`, to check a screen without waiting for four
  o'clock.
- **The car** is a Chevrolet Malibu Premier 2022 by Type_S (Sketchfab,
  CC BY 4.0), since 26 October 2026 (the owner's choice; it replaced Khronos'
  "Car Concept"). Its Chevrolet badges stay, at the owner's request; WENZE
  plates are added front and back — the camera only ever circles the front
  half, so the front plate is the one on screen. The credit is on screen while
  the car is. See `admin/src/pages/grossRace/celebration/CREDITS.md` for what
  was changed in the file. The scene reads the wheels' rims by name
  (`/^Wheel\w*Rim$/`) for their contact shadows: a replacement model needs its
  rims named that way, or the wheels lose their shadows.
- **Two traps are already fixed. Keep the fixes.**
  - The car's floor placement uses PRECISE bounding boxes
    (`setFromObject(…, true)`). The wheels are turned, a turned part's quick
    box reaches below the tyre, and the car hovered.
  - The lit floor disc and the contact shadows are what make the floor visible
    at all. Without them the car reads as floating.

## A racer moves up: the chime and the big card

The owner (6 November 2026): when somebody climbs, an airport-style
"ding-dong" and a big card in the middle of the screen, on both boards
(`admin/src/pages/grossRace/rankUp/`).

- **What counts as a climb** (`pickRankUp.js`, pure): an overtake or a new
  leader from the race feed (`raceEvents.js`, which now carries the place the
  racer came `from`). A gain, 100% of target or a driver on target is not a
  climb, and neither is a racer appearing for the first time. When several
  climbed in one reading, a new leader wins, then the most places gained, then
  the better place reached.
- **At most one card a minute.** A climb inside the pause is not queued — it is
  in the feed already, and the bottom banner announces it as before.
- **The card**: seven seconds; the name very large, "↑ 5th → 3rd" and "passed
  X"; a new leader gets the accent colour and "takes 1st place". While it shows,
  the bottom banner stays down (they would say the same thing twice). The
  page's own colour tokens only.
- **The chime** (`chime.js`): three soft tones made with Web Audio, no sound
  file. Best effort: a browser that does not allow sound without a click
  refuses it quietly and the card shows alone. It never waits on an unanswered
  `resume()`, so a click later cannot release a chime at a random moment. The
  same Chrome shortcut as the video's lets it play by itself; Settings → Gross
  Grand Prix gives one for `/dispatch` too.
- **Never over something that holds the screen**: the 4 PM celebration, the
  video, the sound test. A climb then stays in the feed only. A new week clears
  the card with the rest of last week's race.
- **On `/dispatch`** the board turns to the climber's five
  (`floor((rank − 1) / 5)`) and does not turn on until the card is gone.
- The page does not reload itself for a new build while the card shows.
- **`/dispatch`'s Test sound** shows the card with the chime and says whether
  the chime played and whether sound may start by itself (the same
  `autoplayProbe.js`, asked when the page opens). It runs no celebration and no
  video — those stay `/dispatchteam`'s.

## Birthdays on the boards

The owner (6 November 2026): employees and drivers, on both boards, at the
same time as the Telegram post; an employee with the card that went to the
employee group, a driver with the name and the truck; several in turn, about
fifteen seconds each.

- **One holder, in memory** (`services/grossRace/birthdays.js`): filled right
  after a successful send — the employee card after `employee:<day>:<id>:sent`
  is written (the JPEG that was posted, never drawn again per request), the
  driver after `sendMessage` succeeds, with the truck read from
  `driver_profiles.unit_number` at that moment. **A hook can never cost the
  Telegram post anything**: it runs after the send and swallows its own
  failure. A card re-sent by hand for chosen people ("Congratulate selected")
  is not a birthday on the boards. Each entry is held for a day from its send,
  at most 50.
- **After a restart** (`birthdayRestore.js`, started with the background
  services): one read of the last day's `service_runs` keys — `:sent` for
  employees, the per-group key for drivers — the names and trucks, and each
  employee's card drawn once. Never per poll: `GET /api/gross-race` is still
  answered without a query.
- **On the screen** (`admin/src/pages/grossRace/birthday/`): confetti and
  balloons in CSS, "Happy Birthday!", the card or the name and "Truck 1109",
  fifteen seconds each, in the order they went out. **Once per tab**, kept in
  `sessionStorage`, so the board's own reload after a deploy does not repeat
  them; a screen opened later that day shows them once.
- **Priorities**: the 4 PM celebration, the video and the sound test go first
  — a birthday waits until they are over; a climb card waits for a birthday
  (the climb stays in the feed). No self-reload while a birthday is on.

## The screens update themselves

The owner (12 October 2026): after a code update the office screens should
pick it up without anyone reloading them.

- **Every answer names the page build the server hands out:** `page`, the
  race page chunk's file name, e.g. `GrossRacePage-BgHoDpj_.js`
  (`services/grossRace/pageVersion.js`, read once from `admin/build/assets`).
  Vite hashes that name from the chunk's content. The page knows its own name
  from `import.meta.url`. When two answers in a row name the same other build,
  the screen reloads itself, 30 to 60 seconds after the deploy.
- **What triggers it.** The chunk imports the panel's main chunk, so ANY admin
  code change renames it, not only a change to these pages: editing the
  Samsara settings tab did. A deploy that touches only the server leaves it
  alone.
- **When it does not reload** (`admin/src/pages/grossRace/pageVersion.js`):
  - the server names no build (`null`: tests, `vite dev`, or a doubtful build
    directory), or the page is not a built chunk;
  - on a single answer naming another build. A hash says which build, not
    which is newer, and while a deploy switches over, a screen already on the
    new page can get one answer from the old server (Codex, #280). The new
    build is still there a poll later; a stray answer is not;
  - while the celebration, a climb card or a birthday is on screen, or during
    the 4:00 PM minute, when a fresh page would celebrate a second time;
  - a second time within five minutes. A deploy in progress answers from the
    old and the new server for a while, and must not set a screen reloading
    over and over. The time is kept in the tab's `sessionStorage`.
- **A reload ends the page's own full screen.** Browsers allow the **Full
  screen** button only from a person's click, so after an update a screen in
  that mode drops out of it. For screens that should stay full screen, use the
  browser's own full screen (F11, or a kiosk mode), which survives a reload.
- **A screen whose code never starts reloads itself** (the owner, 2 November
  2026: after an update `/dispatchteam` stayed black while `/dispatch` kept
  working). While a deploy switches over, the old and the new server both
  answer, so a reload can get the page from one and its script from the
  other, which no longer has it. The server answered a missing build file
  with the admin page, the browser refused that as a module, nothing ran — and
  in a kiosk window, with Windows in dark mode, the screen showed the panel's
  near-black background until somebody walked over. Reproduced with two real
  builds. Now:
  - a missing file under `/admin/assets/` is a **404**, never the admin page
    (`server/api.js`; `tests/api-surface.test.js`);
  - an inline script in `admin/index.html` — plain, no imports, so it runs
    when nothing else does — reloads `/dispatch` and `/dispatchteam` if the
    board has not started a minute after the page opened, then after 2, 4 and
    8 minutes, at most every 10. The board stands it down when it mounts and
    clears the count (`pageVersion.js` `markBooted`; the flag and the
    `sessionStorage` key are spelled the same in both, and
    `tests/raceBootWatchdog.test.js` runs the script itself). A board that
    starts and then cannot reach the server is not reloaded: it says so on
    screen and keeps polling, as before.

## `/dispatch` is a new page, not the Dispatch Center

`/dispatch` was the retired Dispatch Center's address and answered 410
([`retired-dispatch-center.md`](retired-dispatch-center.md)). Since October 2026
the bare path serves the shell and the dispatchers' race; **`/dispatch/*` still
answers 410**, so a held deep link into the old page never reaches the shell.
`admin/src/App.jsx` maps both paths from `window.location.pathname` before any
sign-in check, the way it maps `/recruiters`. A trailing slash is ignored
there: `/dispatchteam/` is the teams' board (it used to open the admin shell —
the owner, 2 November 2026), while `/dispatch/` still meets the server's 410.

## Files

| | |
|---|---|
| `services/grossRace/week.js` | the race week (pure) |
| `services/grossRace/standings.js` | which loads count, who they count for, targets, ranking, what the public payload holds (pure) |
| `services/grossRace/feed.js` | the held week, when to read, the failure phrases |
| `services/grossRace/pageVersion.js` | which build of the race page the server hands out |
| `server/routes/grossRaceRoutes.js` | `GET /api/gross-race`, the birthday card, and the video's routes (serve, replace, status, pause, delete) |
| `services/grossRace/birthdays.js`, `birthdayRestore.js`, `database/raceBirthdays.js` | today's birthdays: the holder, its restore after a restart, the reads both need |
| `services/grossRace/celebrationVideo.js`, `videoPause.js` | the video on the server's disk, and whether it is paused |
| `admin/src/pages/settings/GrossRaceTab.jsx`, `settings/grossRace/` | Settings → Gross Grand Prix: the video console and the Windows sound set-up |
| `admin/src/pages/grossRace/` | the page, its stylesheet and fonts (Archivo, SIL OFL), the race feed; `pageVersion.js` decides when a screen reloads itself |
| `admin/src/pages/grossRace/celebration/` | the 4 PM celebration: when and whom (pure), the three.js scene, the overlay, the car and its credits |
| `admin/src/pages/grossRace/rankUp/` | a racer moves up: which climb (pure), the chime, the card, and its timing (`useRankUp.js`) |
| `admin/src/pages/grossRace/birthday/` | birthdays: whose next, once per tab (pure), the overlay, its timing (`useBirthdays.js`) |

## Tests

```
node --test tests/grossRaceStandings.test.js tests/grossRaceFeed.test.js tests/grossRaceRoutes.test.js tests/grossRacePageVersion.test.js tests/grossRaceVideo.test.js tests/grossRaceVideoConsole.test.js
node --test tests/grossRaceBirthdays.test.js tests/grossRaceBirthdayRestore.test.js tests/birthdayService.test.js tests/employeeBirthdayRaceBoard.test.js
node --test tests/raceBirthdaysPg.test.js   # requires TEST_DATABASE_URL
node --test tests/api-surface.test.js   # /dispatch and /dispatchteam serve the shell; /dispatch/* → 410
npm test --prefix admin -- --run src/pages/grossRace src/pages/settings/GrossRaceTab.test.jsx
```

## The "Test sound" button

The owner wanted a video with sound after the 4 PM celebration (16 October
2026; see below). The office screens are Windows computers (the owner, 26
October 2026; this page said Smart TVs before), and a browser decides for
itself whether a page may start sound without a click, so the board
that will play it carries a **Test sound** button that finds out
(`admin/src/pages/grossRace/soundTest/`). **The video is `/dispatchteam`'s
alone** (the owner, 16 October 2026): `/dispatch` keeps the car only. Its own
**Test sound** (since 6 November 2026) is the climb chime and card, above.

- **When the page opens**, before anybody presses anything, it tries to start
  a quarter of a second of silence with sound on (`autoplayProbe.js`). Whether
  the browser lets it is the one answer the 4 PM video depends on.
- **A press** runs what 4 PM will run: the celebration of the current leader
  (the 3D car, or the trophy where the TV cannot draw it), then a five-second
  clip of our own with two chimes (`sound-test.mp4`, made for this, no
  third-party content), then a card that says, in large letters, whether sound
  may start by itself, whether the clip played with sound, whether the 3D car
  showed, and the browser's name. The card closes itself after a minute.
- The page never reloads itself for a new build while a test is running.

## The video after the celebration

On `/dispatchteam`, the company's video follows the car (the owner, 16 October
2026); `/dispatch` keeps the car alone.

- **The file is on the server, never in this repository**, which is public:
  `GROSS_RACE_VIDEO_PATH`, by default `data/gross-race/celebration.mp4` under
  the app (`/app/data/...` in the container, a Coolify volume, so a deploy
  keeps it). `/data/` is ignored by git and by the Docker build.
- `GET /api/gross-race/video` serves it with no sign-in (the screens have
  none), in byte ranges, `Cache-Control: no-cache`, so a replaced video
  reaches the screens the same day. `GET /api/gross-race?view=teams` says
  `video: true` when there is one; without one the car plays alone.
- `PUT /api/gross-race/video` (an MP4 body, `Content-Type: video/mp4`, at most
  100 MB) replaces it; signed in with full admin access. It is written beside
  the old file and renamed over it, so a screen never reads half an upload.
- **On the screen** (`celebration/useCelebrationVideo.js`,
  `CelebrationVideo.jsx`): while the car is on, the video is fetched out of
  sight; when the car is gone it starts, with sound if the TV allows it and
  without if not, rather than not at all. When it ends, fails, or after three
  minutes, the board is back. A sound test never leads to it, and the page
  never reloads for a new build while it plays.
- **One-off catch-up** (`celebration/catchUp.js`, `CATCH_UP_DAYS`): on
  16 October 2026, the day the video went live after four o'clock, a screen
  shows the celebration once when it opens (once per tab; `/dispatchteam`
  waits until the server has the video). Other days are unchanged.

## Settings → Gross Grand Prix: the video console

The owner (26 October 2026): manage the video from the admin panel, and know
how to make a screen always play it with sound.

- **See it**: whether there is one, its size and upload time, a player.
- **Pause / Resume** — the video only; the car still celebrates at 4 PM.
  Paused, `GET /api/gross-race?view=teams` answers `video: false`, so a screen
  shows the car alone, and a screen already playing the video closes it on its
  next poll (within about 30 seconds; `useCelebrationVideo` closes a video the
  server no longer offers). The file stays. The setting is
  `celebration-state.json` beside the video on the same volume, so it survives
  a deploy, and it is NOT in the database on purpose: every screen asks every
  30 seconds, and that answer is built without a query. A state file that
  exists but cannot be read counts as **paused**, never as "play".
- **Upload a new one** — MP4, at most 100 MB, with a progress bar (the same
  `PUT /api/gross-race/video`, replaced only once all of it has arrived).
- **Delete** — after a confirmation; the car plays alone.
- `GET /api/gross-race/video/status`, `PUT /api/gross-race/video/paused`
  `{ paused }` and `DELETE /api/gross-race/video` need a full admin, like the
  upload. `GET /api/gross-race/video` stays public: the screens have no
  sign-in, and the admin preview uses it while the video is paused.
- **Always with sound (Windows).** A browser will not start sound on a page
  nobody clicked, so the board falls back to playing muted. The tab gives the
  command for a desktop shortcut, with this server's address filled in:
  Chrome with `--kiosk` (full screen that survives the board's own reloads),
  `--autoplay-policy=no-user-gesture-required` (sound may start by itself) and
  `--user-data-dir` (a profile of its own, because Chrome ignores switches
  handed to a profile that is already running), plus `shell:startup` to open
  it when the computer starts. Edge takes the same switches. A second Chrome
  command opens `/dispatch` the same way, in a profile of its own, for the
  climb chime. **Test sound** on the board confirms it.
