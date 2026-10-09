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
  Unset, unreadable or past means OFF; more than 45 days away is read as a
  typo and is OFF, loudly. There is **no default date in the code**, so a test
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
  home-out pass follows it.
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
those caches at once, and the router clears the roster itself when it puts a
provider on cooldown.
