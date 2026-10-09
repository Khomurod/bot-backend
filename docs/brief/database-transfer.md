<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list. -->

# §7b. The database transfer budget, and economy mode

Moved out of §7 (`background-jobs.md`) when that file reached the 500-line
limit. The full rules for economy mode live in
[`docs/architecture/economy-mode.md`](../architecture/economy-mode.md).

## The meter and the warnings

The hosted database (Supabase) has a **monthly data-transfer allowance**, and
this deployment reached **4.222 GB of 5 GB** with nothing in the application
aware of it. Exhausting it is not a graceful degradation: reads simply start
failing, and before this work the app could not tell that apart from an outage.

Three mechanisms now keep it in view and in check:

- **A meter.** `database/pool.js` is the single query boundary, so every result
  feeds `database/transferMeter.js`, which estimates the bytes read this month
  (sampled result sizes plus a moving average of bytes-per-row — measuring every
  row would double the work of every large query). `database/transferUsage.js`
  persists it to `database_transfer_usage` (one row per UTC month, one UPSERT a
  minute) so a Render restart does not reset the month.
- **And WHAT is spending it.** A percentage tells somebody to worry; a table
  name tells them where to look. `lib/database/queryLabel.js` reads the table
  out of the statement itself — one regular expression, run on every query, and
  it returns an **identifier or `other`, never a fragment of the SQL**, because
  SQL text carries literals and literals carry driver names and money codes.

  The capture shape alone was not enough, and the first version proved it: a
  pattern is only SQL structure where SQL structure is allowed, so
  `/* report from Alice_Smith */ SELECT * FROM groups` labelled itself
  `alice_smith` — a well-formed identifier and a person's name, on a
  diagnostics endpoint. Comments and quoted literals are blanked out **before**
  the match, in one left-to-right pass (stripping comments first mangles a
  literal containing `--`). Double quotes are left alone, because in PostgreSQL
  those delimit an identifier and that is the thing being looked for.
  The meter keeps per-table bytes, queries and rows, and `/api/system/
  database-usage` returns the ten biggest as `breakdown`.

  Two limits, each a way it could have gone wrong. **The label set is capped**
  (80 by default) with an `other` bucket, so a diagnostic that runs on every
  query for the life of a process cannot grow without bound — and the parts
  still sum to the whole, so the answer gets coarser rather than wrong. And the
  breakdown is **scoped to the process, not the month**: the monthly total is
  persisted so a restart cannot lose it, while attribution answers "what is
  spending it right now", and a share carried across a deploy would describe a
  process that no longer exists. Restarting resets the breakdown and never the
  total.
- **Warnings at 80 / 90 / 95%.** Logged once per threshold per month by
  `services/databaseUsageService.js`, and shown in the admin panel by
  `DatabaseUsageBanner` (which reads in-memory counters — the meter performs no
  query of its own) alongside the three tables reading the most. Both say
  plainly that the number is this app's estimate, not the provider's invoice,
  and the banner says the table list covers only this server's uptime. The
  banner is the ONE component rendered outside `PageErrorBoundary`, so the
  breakdown is read defensively: a malformed one costs the list and never the
  warning. **Nothing throttles or blocks a query on this
  budget**: enforcement belongs to the provider, and silently refusing reads
  would turn a warning into an outage. No provider or billing setting is ever
  changed by the app.
- **Less traffic to begin with.** The brakes are the server-side TTL caches with
  single-flight collapsing (Live Locations: 90s snapshot, 3 min order window),
  the visible-only browser polling (§7, `background-jobs.md`), and bounded list queries (the
  scheduled-messages queue returns every live row plus a capped tail of finished
  history instead of the whole table on every poll).

## Economy mode — standing work down until the allowance resets

**October 2026.** Free plan, grace period over, 4.81 of 5 GB used with eleven
days of the cycle left, and the application spending **0.3–0.45 GB a day**.
Going over restricts the database outright — every feature stops, not just the
costly ones. The owner chose what keeps running; everything else stands down
until a date.

- **The switch is `ECONOMY_MODE_UNTIL`** (an ISO date-time, set in Render).
  Unset, unreadable or past means OFF; more than 45 days after the process
  started is read as a typo and is OFF, loudly, for the life of the process. There is **no default date in the code**, so a test
  run or a fresh deploy can never pause anything by accident. When the date
  passes, every held service starts by itself — no deploy, no restart.
- **Kept running:** driver chats and home-time requests (with their
  reminders), Samsara alerts (a separate service), Facebook and SMS leads and
  the after-hours answers, money codes, scheduled broadcasts, the delivery of
  every notice, birthdays, the weekly raise review, mileage and road bonuses,
  route control, ETA updates and return-to-road detection.
- **Stood down** (`ECONOMY_PAUSED_KEYS`, `lib/operations/economyMode.js`):
  BOL/POD forwarding, load control, the consistency sweep and everything that
  rides it (contradictions, owner questions, the daily digest), self-healing,
  the learning pass, the duplicate-unit scan, decision grading, fuel risk and
  fuel-stop reminders, retention and chat annotation, and the AI checks (group
  status, model maintenance, the terms watcher, the safety coach).
- **Slowed, not stopped:** the Dispatcher Board is read every **4 hours** —
  the Sunday raise review refuses a Board older than 6 — and the home-in /
  home-out pass follows it. A failed read retries at the normal pace.
- **The health endpoint skips its `operations` block** and says
  `economy: { active, until }` instead; the cron pinger was building it about
  150 times a day.
- **It is not a throttle.** No query is ever refused for being over a budget —
  the rule above still holds. Economy mode is a dated list of passes that do
  not run, chosen by a person.

**Cheaper all the time, economy or not** (the same audit): the pool keeps an
idle connection 10 minutes with TCP keepalive instead of reopening it after
30 seconds (every reconnect is a TLS handshake plus authentication, metered);
the AI roster is cached 10 minutes and never reads the providers' model
listings, whose ids are read separately and cached 12 hours; the
per-capability switches are cached 10 minutes. Every admin save still clears
those caches at once, the router clears the roster itself when it puts a
provider on cooldown, and a success clears that provider's cached failure count
just as `recordSuccess` does in the table. The effective ELD settings
(`getEldConfig`, on the location resolver's hot path) are cached 5 minutes
instead of 30 seconds, and a save clears them at once. So are the Finance
Monitor's settings (`isFinanceChat` asks on every message in every chat): 10
minutes instead of 30 seconds, cleared at once by `updateFinanceSettings`, the
row's only writer. In both, a read already out when a save clears the cache
still answers its own caller but is not kept, so a save can never be undone
for the length of the TTL by a read that raced it.

## What one driver message costs

October 2026, measured: about **5.7 KB and ten statements per message**, at
roughly ten thousand messages a day. Now a repeated message costs **one
statement**: the `bot_users` upsert, which counts messages and reads nothing
back. In production the chat-capture insert is a second. The rules that got it
there, each pinned by `tests/perMessageQueries.test.js`:

- **The `groups` row is cached for 5 minutes** (`database/groupRowCache.js`).
  Every write to `groups` in this process clears it, and the cached copy is
  only used when the chat's title is unchanged.
- **Writes that would change nothing are not sent**
  (`bot/handlers/captureWriteMemo.js`):
  - `drivers` and `group_members` are re-written when a name changes, or
    every 15 minutes. So `group_members.last_seen_at` is at most 15 minutes
    behind; it only orders the admin's username dropdown.
  - The two Telegram-id backfills retry every 6 hours.
  - The group's `last_message_seen_at`, a diagnostic, refreshes every
    5 minutes.
  - A write that fails is tried again on the next message.
- **The person behind a chat is remembered with the time**, so the identity
  resolver's 10-minute window no longer re-reads the link on every message.
- **The legacy home-time clarification lookup** runs only after the home-time
  candidate filter.

**BOL/POD**, paused in economy mode, is cheap again before it resumes. A scan
reads where every document in its window stands in ONE narrow statement and
skips the settled ones (`docs/architecture/bol-pod-forwarding.md`). Before, it
upserted and read back a full row for each of ~430 documents on every pass,
about 100 MB a day.

**Load control**, also paused in economy mode, was the largest consumer
measured: about 110 MB a day. It now costs one read of each table per pass,
whatever the number of loads (`tests/loadPassQueries.test.js`):
- the active driver groups, as id and title only;
- the holders of every unit on the board, in one `= ANY` read;
- where every load stood before, only the columns the pass uses.

A pass reads back nothing it writes. Before, every ten minutes and for each of
~205 loads, it read `SELECT *` from two tables and echoed its write back whole.
Which load and who it belongs to after a write is worked out in
`identityAfterWrite` (`database/loadLifecycle.js`), with the same COALESCEs as
the SQL. A PostgreSQL test pins the two together.

If the read of what each load witnessed fails, the pass ends there. Nothing is
written and no finding is resolved, because phases worked out without that
memory would forget an arrival.

**The health endpoint's `operations` block** is built at most once every 15
minutes (it was once a minute), and never for a HEAD request, whose body nobody
receives. Render's own health check polls `/api/health`, so a one-minute cache
meant up to 1,440 builds a day of ~46 statements each. The block reads each AI
provider's model-listing SIZE (`summariseProvidersForHealth`), not the listing,
which was about 43 KB for OpenRouter's (`tests/healthOperationsCost.test.js`).

**The consistency sweep reads only the chat members who could be a driver**
(`services/operations/snapshot/loaders.js`). Nearly every row of
`group_members` is staff: dispatchers and managers sit in every driver chat.
The sweep read all 7,471 rows every 15 minutes, about 48 MB a day. It now reads
only the memberships of active driver chats held by accounts in fewer than
`STAFF_GROUP_COUNT` of them. Those are the only accounts the staff rule cannot
already exclude. All of such an account's memberships are read, so its chat
count is unchanged. Of `bot_users`, it reads only the sources the staff rule
looks at. `tests/telegramMembersNarrowing.test.js` proves the identity checks
file exactly the same findings from that as from the whole table.
`tests/telegramMembersSnapshotPg.test.js` holds the SQL to the same model.

**A filed finding returns its id only** (`upsertFinding`). Every caller wanted
the id for its keep-list. The load watch and the consistency sweep re-file
hundreds of findings every few minutes, and `RETURNING *` echoed each one back
whole, evidence included. Read a finding with `getFindingById` when you need
it.

**The polls that nearly always find nothing:**
- the scheduler asks for ids only;
- the dispatch-ETA claim looks first with a one-column query, because it
  describes all 18 columns even when it claims nothing;
- the auto-reaction rules are cached 10 minutes, and every admin save clears
  that cache.

## What the owner-questions pass costs

The ask pass (`control_ask_pass`, every 15 minutes; stood down while economy
mode is on) read roughly **300 KB a tick** whatever it then did — up to 200
whole decision rows for the holds (~160 KB), a hundred whole findings
(~100–150 KB), and one `control_knowledge` lookup **per finding** — and most
ticks then stopped at the standing cap on unanswered questions or the daily
limit, having used none of it. Now a tick **decides whether it may ask
first**. One that may not sends the settings read, one or two counts and one
look for candidates the owner already answered (normally none): **about
1 KB**. The look stays because closing a settled finding never waits for the
cap; such a tick reports `considered: null` rather than read every candidate
to count it. A tick that can ask reads 13 of a finding's 20 columns
(`listAskCandidates`; the admin's `listFindings` stays whole), the five a hold
needs, and its memories in **one** statement by exact subject
(`findMemoriesFor`, the match `findMemory` made per finding). Measured on a
test seed of 400 open findings and 220 holds: 337 KB and 105–108 statements a
tick before; after, 0.8–0.9 KB and 3–4 statements when it may not ask, and
116 KB and 9 when it may — most of that the candidates' evidence and proposed
change, which the questions are worded from. Pinned by
`tests/askPassQueries.test.js` and `tests/askPassReadsPg.test.js`.

**Route Control's monitor tick** runs every five minutes, economy mode or not.
Measured against PostgreSQL it cost ~3.2 KB a tick with no route at all, plus
~12.4 KB for every tracked route — ~0.9 MB a day idle and ~3.5 MB a day more
per route. It re-read the GMaps settings whole on every tick (a 30-second cache
never survives a 300-second tick), read every route whole, and echoed each
write back with `RETURNING *`. Now an idle tick asks one one-column question;
the pass names the columns it uses; the polyline is fetched only when an
off-route check or a destination repair needs it, then remembered until it
changes; writes read nothing back; and the settings are cached 10 minutes, a
save clearing them. Measured the same way: ~0.5 KB a tick idle, ~1.7 KB with
one tracked route, ~0.4 KB for each route after that (~130 KB, ~470 KB and
~106 KB a day). The rules are in
[`route-control.md`](../architecture/route-control.md), and
`tests/routeMonitorQueries.test.js` holds the tick to them. Still read on a tick
that has a route: the live-GPS resolver's ELD settings, which fold in the
Samsara settings and are cached 5 minutes (see above).

## The two home-time passes that never stand down

Both keep running in economy mode, so both were made cheap instead (October
2026; figures measured on a seeded local copy, old code against new).

**The return-to-road watch** (every 12 minutes) received the whole 24-column
watch row FOUR times for each driver at home — the create echoed it, a
`SELECT *` read it, and both observation writes echoed it — every copy
carrying a `last_signals` JSON the pass never reads back; the audit put it at
~12 MB a day. Now the create IS the one read, returning the eight values the
score uses; the sighting write echoes only the four it can change, still
computed by the database, because the moving-sighting counter's guards have
been wrong twice in ways only the real statement showed; the verdict write
returns nothing. The at-home list stopped reading two columns nothing used,
and the tidy-up counts what it drops. Eight drivers at home: 48 KB → 6.4 KB a
pass (~0.8 MB a day), and it no longer grows with the stored signals. The
correction still reads the whole row under its own lock; it runs only when a
return is applied, so it was left alone. `tests/returnToRoadPassQueries.test.js`,
`tests/homeTimeReturnWatchPg.test.js`.

**The home-time housekeeping tick** (every 5 minutes) read the whole settings
row twice, once per sweep; all 46 columns of every open request, to judge each
on five dates — and legacy `pending` rows with no dates stay open, so that was
every tick; and claimed staff alerts with an `UPDATE … RETURNING r.*`, which
describes all 46 columns even when nothing is due — nearly always. Now the
tick reads `enabled` and the staff chat ONCE and hands them to both sweeps
(inside the run-ledger callback, so a failed read is still that run's error);
the open requests come back as the six columns the closing rule reads; and the
claim looks first with `SELECT 1 … LIMIT 1` under the SAME predicate, then
returns only the twelve columns the sender reads. Idle it costs ~0.6 KB plus
~70 B per open request, from ~4.6 KB plus ~535 B: with ten open requests,
~2.9 MB a day → ~0.4 MB. Nothing is sent at a different time; the one
difference is that a settings save landing DURING a tick counts from the next
tick. `tests/homeTimeTickQueries.test.js`, `tests/homeTimeHousekeepingPg.test.js`.

## The recruiter leaderboard and the RingCentral sync

October 2026, measured on PostgreSQL 16 at this deployment's row sizes:
`/recruiters`, left open on a screen and polling every 60 seconds, cost about
35 KB a poll by the end of a working day (460 calls). A 10-minute call-sync
pass cost about 20 KB, and each 15-minute extension check from the leads worker
6.5 KB.

- **The board is totalled in SQL and kept between polls.** One row per
  recruiter (`count(*) FILTER`, `sum`, about 0.7 KB) replaces one row per
  call. The public answer is kept in the process
  (`database/ringcentral/leaderboardCache.js`) until one of these happens:
  - a call is written;
  - a recruiter is created, changed or deleted;
  - the KPI settings are saved;
  - five minutes pass (the net for a write by another instance);
  - for "today", midnight in the configured time zone.

  A poll in between costs nothing. The JSON is byte-for-byte what the old
  JavaScript produced (`tests/recruiterLeaderboardPg.test.js`). The admin
  `/stats` page uses the same SQL but not the cache.
- **The RingCentral settings row is kept until it changes.** The cache now
  lasts up to 30 minutes instead of 15 seconds. Every save in the process clears
  it. The sync's own stamp updates the cached copy instead of throwing it away,
  which used to cost every pass a second read. A failed read is still kept only
  15 seconds, so a blip cannot read as "RingCentral is off".
- **The sync reads nine recruiter columns, and only when they changed.** Each
  pass first asks for an md5 of exactly those columns, about 100 bytes. It
  re-reads the rows when the hash differs: a rotated refresh token, an admin
  save, another instance's write. It never relies on invalidation hooks alone,
  because a pass holding a spent refresh token flags a healthy recruiter
  (`docs/architecture/recruiter-sms-sender.md`).
- **A call already written with the same values is not written again**
  (`database/ringcentral/calls.js`). The ~33,000 upserts a day become the new
  and changed calls. A failed write is forgotten. An unchanged call is still
  re-written every six hours, as the net for a write this process did not make.
- **The extension check reads `id, name, rc_extension_id`**, not every
  encrypted token: 6.5 KB down to 0.25 KB, 96 times a day.

A scheduled sync pass that finds nothing new now sends four statements: the
roster hash, the sync stamp, and the run ledger's two. It used to send six plus
one per call since midnight. Pinned by
`tests/recruiterCallSyncQueries.test.js` and
`tests/recruiterLeaderboardQueries.test.js`.
