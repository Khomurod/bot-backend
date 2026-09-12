<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list. -->

# §7. Automatic and background behavior

**What is true of ALL of them** — the run ledger, the shared fleet snapshot,
data retention, and why nothing is heard until a destination is configured —
lives in [`background-job-rules.md`](background-job-rules.md). This document is
the jobs themselves.

There is **no cron library** — every job is a `setInterval` or self-rescheduling
timer started from `index.js` and stopped by the shared shutdown coordinator.
**They all send real messages to real people.**

Most of them poll on a **short, cheap tick and gate internally** on a
time-of-day or on due rows — so the tick cadence is not the business cadence.

**Jobs with a KNOWN next due time now sleep until it** instead of polling
(`services/dueTimeWakeTimer.js` for weekly jobs, `services/dailyWakeSchedule.js`
for once-a-day jobs, `services/jobQueueScheduler.js` for durable queues). Those
wakes land ON the due moment, so they are more punctual than the poll they
replaced, not less. Every sleep is **capped** (an hour) so a config change is
picked up without a restart, and a failed send always re-arms on a short retry
cadence. Queue workers additionally drain **on the producer's event**, so a
Facebook lead is delivered on the same tick it
arrives — the sweep is only a crash/lost-wake backstop. Guarded by
`tests/facebookWebhookImmediateProcessing.test.js` (a lead is still delivered
without any timer firing), `tests/jobQueueScheduler.test.js` and
`tests/backgroundWakeTimers.test.js`.

| Service | Tick | What it does |
|---|---|---|
| `schedulerService` | 60s + hourly retention | delivers due `scheduled_messages` |
| `dispatchEtaUpdateService` | 90s | per-group ETA updates, `FOR UPDATE SKIP LOCKED` claims |
| `birthdayService` (drivers) | sleeps to the next 08:00, re-checks hourly (was 60s) | wishes at an hour/timezone **hardcoded in the module** (08:00 America/Chicago) — there is no settings row or env var for it |
| `employeeBirthdayWishService` | sleeps to the configured send time, re-checks hourly (was 60s) | wishes at the `send_hour` / `send_minute` / `timezone` from `employee_birthday_settings` |
| `groupStatusAiService` | 60s | AI classification of group activity |
| `mileageBonusService` | sleeps to the next Wed 07:00, capped 1h (was 60s) | milestone detection → bonus notification |
| `raiseApprovalService` | sleeps to `next_run_at`, capped 1h; re-armed on a settings save (was 60s) | weekly raise round auto-send, `service_runs` dedupe |
| `fuelStopAlertService` | 150s | fuel-stop proximity replies |
| `homeTimeReminderService` | 5 min (first tick +30s) | the two clarification reminders |
| `services/homeTime/returnToRoadWatch.js` (`startReturnToRoadWatch`) | 12 min, first tick 4 min | Watches drivers who are at home and decides whether they went back to work — Datatruck load + truck movement. No driver at home means no provider call at all. Files a finding; the corrections pass applies the high-confidence ones. **Each driver is checked inside its own try**: one that throws is counted and its error KIND recorded, and the pass is a failure only when every watched driver failed. Every timestamp it stores comes from a provider or from Datatruck and goes through `lib/database/timestampValue.js` first — an unreadable one becomes null rather than aborting the write |
| `roadBonusNotifierService` | 10 min (first tick +20s) | retry safety net for road-bonus summaries |
| `datatruckDocumentService` | `DATATRUCK_DOC_POLL_MINUTES` (15) | new BOL/POD → matching driver group, deduped |
| `duplicateUnitCheckService` | 15 min (first tick +90s) | duplicate-unit / name-mismatch reports, **and the only writer of `groups.samsara_vehicle_id`** |
| `modelMaintenance` (AI) | daily 06:00 UTC (first tick +3 min), plus a 5-min-debounced verification when the router is refused a model | re-reads each enabled provider's `/models`; retires what is gone, keeps the operator's order, fills from Wenze's picks; files a `discontinuation` finding and a plain-words Telegram line. A failed listing changes nothing |
| `consistencyService` | 15 min (first tick +120s) | one snapshot → every pure check → findings filed and cleared ones resolved — **then the permitted Tier-1 corrections are applied, in the same guarded run**. Default deny per check; the Findings card shows "Auto-applied N of M" |
| `control/askPass` | rides the consistency timer (15 min), after the contradiction pass and before the notification drain | turns open findings the owner has not yet permitted into ONE plain question each in the notifications group, capped at `max_questions_per_pass` (5) per pass AND as a standing cap on questions still unanswered — so it asks nothing while the owner is still working through the last five — oldest first, not repeated inside `repeat_after_hours` (72). Also the caller that finally writes `suggest` rows to the decision journal. Asks nothing when the channel is switched off. Before asking, it checks `control_knowledge`: a finding whose condition the owner has already answered "no" to is closed from that answer instead of asked again, and `times_applied` is counted |
| `routeControlService` (monitor) | settings-driven, floor 30s | destination completion + off-route warnings |
| `dispatchBoard/poller` | settings-driven, default 5 min (60–3600s), first read +60s | reads the Dispatcher Board into `dispatch_board_rows` and stops there — **the only writer of the snapshot**. Decides nothing, sends nothing, and **never marks a row absent on a pass that failed**: "we could not read the board" and "nobody is on the board" are opposite facts. `blocked` while it is switched off or unconfigured |
| `recruiterCallSyncService` | self-rescheduling `setTimeout` | RingCentral call-log sync |
| `ringCentralTokenRefreshService` | daily, plus once at boot | renews each recruiter's RingCentral OAuth login (refresh tokens expire in 7 days and rotate on use) and flags a dead grant as `rc_auth_error` |
| `facebookWebhookService` worker | drains on arrival; retry wakes on `next_retry_at`; 15 min idle sweep (was a 5s poll) | verified Meta webhook events with retry |
| `databaseUsageService` | 60s flush | persists the estimated monthly database transfer and logs once at 80/90/95% of the budget |
| `memoryWatchdog` | **off by default**; 15 min when on | heap/RSS pressure logging. Requires `MEMORY_WATCHDOG_ENABLED='true'`; `MEMORY_WATCHDOG_INTERVAL_MS` is clamped to ≥60s |
| Python leads child | supervised process; **liveness probed every 10 min** (first probe +60s) | Meta + RingCentral webhook intake. The probe GETs the child's own `/health` on loopback and records the answer in the run ledger — a spawn is a lifecycle event, not a heartbeat, and before the probe existed a healthy child read `stale_stopped` after an hour |
| leads-bot RC subscription reconciler | 15 min (first pass +3s) | re-registers the inbound-SMS subscription **only when the recruiter extension set changes**, so a recruiter who onboards after boot has their replies mirrored without a restart |

Event-driven (no timer) but equally live: the driver-group message pipeline
(`bot/handlers/groupCaptureHandlers.js`) fans a single incoming message out to
home-time detection, fuel-stop capture, auto-reactions,
pinned-context snapshots, and the recent-message buffer.

**None of this depends on a browser.** Every job above is started by
`index.js` at boot and stopped only by the shutdown coordinator; no route, no
login and no admin page starts, feeds or keeps one alive. Route monitoring,
fuel monitoring, birthdays, Samsara/ELD reads, dispatch ETA, the alert queues
and the alert queues all continue with the admin panel closed — the
panel is a viewer, never the engine. (Nothing in `server/routes/**` calls a
`start*Service`, and no route module holds an interval at all.)

### The database transfer budget

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
- **Warnings at 80 / 90 / 95%.** Logged once per threshold per month by
  `services/databaseUsageService.js`, and shown in the admin panel by
  `DatabaseUsageBanner` (which reads in-memory counters — the meter performs no
  query of its own). Both say plainly that the number is this app's estimate,
  not the provider's invoice. **Nothing throttles or blocks a query on this
  budget**: enforcement belongs to the provider, and silently refusing reads
  would turn a warning into an outage. No provider or billing setting is ever
  changed by the app.
- **Less traffic to begin with.** The brakes are the server-side TTL caches with
  single-flight collapsing (Live Locations: 90s snapshot, 3 min order window),
  the visible-only browser polling below, and bounded list queries (the
  scheduled-messages queue returns every live row plus a capped tail of finished
  history instead of the whole table on every poll).

### Browser polling (the admin panel)

Every automatic refresh in the panel goes through
`admin/src/utils/useVisibleInterval.js`, which **skips ticks while the tab is
hidden and stops entirely when the section is closed**, then refreshes once on
return. A dashboard left open overnight therefore costs nothing.

| Page | Interval | Notes |
|---|---|---|
| Live Locations | **2 min** | server snapshot cache is 90s, so several tabs collapse onto one build; the explicit Refresh button passes `force=true` |
| Leads | 45s | new leads also arrive by Telegram, so the page is not the notification path |
| Scheduled messages | 60s | was an ungated 30s `setInterval` that polled from background tabs forever |
| Mileage bonuses | 8s | **only while a run is in progress** |
| Recruiters leaderboard (public) | 60s | only in "today" mode |

Do not add a bare `setInterval` that fetches — use the hook, or the next
dashboard left open on a wall display becomes the largest line in the transfer
bill.

### Idempotency ledgers — do not weaken

Each of these stops a duplicate real-world action (a second message, a second
payment notification, a second bonus). **Never turn a successful send into a
retry.**

| Guard | Stops |
|---|---|
| `mileage_bonus_notifications` UNIQUE `(driver_normalized_name, threshold_miles)` | the same milestone being announced twice |
| `mileage_bonus_runs` (leased, unique `run_key`) | a weekly **run** overlapping or replaying itself |
| `service_runs` | a scheduled service firing twice for one due window |
| `facebook_webhook_events` (`leadgen:<pageId>:<leadgen_id>`) | a re-delivered Meta lead being posted twice |
| `facebook_lead_sms_mirrors` | an SMS reply being mirrored twice |
| `datatruck_document_deliveries` | the same BOL/POD being forwarded twice |
| `fuel_monitor_inbox` | one fuel-stop post creating several watches |
| `dispatch_eta_updates` / `fuel_stop_alerts` claim pattern (`FOR UPDATE SKIP LOCKED`) | two ticks working the same row |
| `driver_road_history.bonus_posted_at` (atomic claim) | a completed road leg being announced twice |
| home-time clarification claims (count + `next_reminder_at`) | a restart doubling a reminder |
| `responses` UNIQUE `(driver_id, question_id)` | a driver answering one question twice |
| `route_assignment_attachments` unique index | a second screenshot per assignment (replacement is a single UPSERT) |

`bot_sent_messages` belongs to this family but is **not** a guard — it is the
after-the-fact record of what was sent (§4).

---

## Load lifecycle watch (every 10 minutes, first pass 5 minutes after boot)

`services/loads/lifecycleWatch.js`. Works out what each active load is actually
doing — assigned, heading to pickup, at pickup, loaded and moving, at delivery,
delivered, empty — and writes it to `load_lifecycle`, one row per Datatruck
order.

**Dispatch status is a plan, not an observation.** A load reads `dispatched` the
moment somebody assigns it, often days before the truck moves, and frequently
still reads `in_transit` long after delivery because nobody went back to change
it. So the phase comes from **where the truck is**, with the board as a
corroborating signal.

Two things follow, enforced in `lib/loads/lifecycle.js` rather than left to a
caller:

- **Arrival is observed, departure is remembered.** "At pickup" is a distance
  measurable right now. "Delivered" is not: it is the truck having been at the
  receiver and then left, and a truck 200 miles short of a receiver looks
  identical to one 200 miles past it. `was_at_pickup` and `was_at_delivery` are
  OR-ed and never cleared, because a departure is not evidence the arrival was
  imagined.
- **A conflict needs positive evidence, not merely a board that is ahead.** A
  lagging board describes almost every delivered load, so only a board claiming
  MORE than the coordinates support was ever considered — and production showed
  that is still not enough: **75 of 235 loads came back conflicted, a third of
  the fleet**, which is not a list anybody reads. Two innocent situations were
  being caught. A truck parked mid-trip with the board marked loaded lands on
  `assigned` for want of a remembered arrival, and produced "the truck has not
  left the shipper" about a truck three hundred miles from it. And a delivered
  load this watcher started following late produced "the truck is still at the
  receiver" about a truck driving away from it — absence of memory is not
  evidence that the delivery did not happen.

  A conflict now requires the truck to be seen somewhere the board's claim
  cannot be true from: **delivered while the truck is at the shipper** (the
  strongest — a completed delivery recorded for a truck at the pickup),
  **delivered while a load we have actually been watching was never seen at the
  receiver**, or **loaded while the truck is still at the shipper**. Everything
  else where the board runs ahead is recorded as the signal
  `board_ahead_of_what_has_been_observed`, which keeps the confidence honest
  without making it somebody's question.

A conflict never moves the phase. It files `load.phase_unclear` at the `warning`
tier, which has **no registered action**, so "Wenze never guesses a load's
status" is true by construction rather than by care.

**Cost:** one fleet fetch and one order window per pass, matched locally, so
ninety loads cost the same as one. It deliberately does not build the Live
Locations snapshot, which geocodes and computes ETAs nothing here reads.

The driver on a load is resolved through `driver_units` to a **person**, not a
chat, so a truck or group change does not detach a load from its history.

Visible on `/api/health` → `operations.loads`: how many loads are tracked, in
what phase, how many are unclear and how many have a board disagreement.

## Fuel risk watch (every 20 minutes, first pass 7 minutes after boot)

`services/fuelStop/riskWatch.js`, beside the existing fuel-stop reminder rather
than replacing it. That one answers a single question — has the truck reached
the station dispatch named? — and answers it well. This one asks the questions a
person actually asks: can it *get* there, did it drive past, is the instruction
from last trip, and is it burning fuel faster than usual.

**A missing reading is not a low one.** Most of this fleet does not report fuel
at all, so every threshold in `lib/fuel/risk.js` requires an actual number and
absence produces silence. The danger is specific and was caught in review of
this very module: `Number(null)` is `0`, so any threshold written with a
coercion reads "does not report fuel" as "empty tank" and alerts on the whole
fleet on its first pass. A genuine `0` IS a reading, and a serious one.

**Distance alone never means "passed."** A truck 200 miles short of a station
looks identical to one 200 miles beyond it, so the rule needs the previous
reading — it has to have been closer before.

**Two deliberate limits while this is new.** Nothing messages a driver group;
every finding goes to the configured operations chat. A fuel alert to a driver
is an instruction, and an instruction from a rule nobody has watched running yet
is how a fleet learns to ignore the bot. And nothing changes a record: a fuel
risk is an observation, not a correction.

Each risk kind has its own quiet window — a passed stop is settled history
within a day, a low tank matters again after a shift — so one condition cannot
fill the channel.

**30% IS THE OPERATIONAL LOW-FUEL THRESHOLD.** It is the business rule and it
had silently become 15% in `lib/fuel/risk.js`'s defaults, which made the feature
stricter than the thing it was built to enforce: a truck at 28%, the case an
operator wants to hear about while there is still time to route it, produced
nothing at all. There are now three bands under ONE `low_fuel` risk kind —
`low` at 30%, `short` at 15%, `critical` at 8% — rather than three risk kinds,
because the quiet window is keyed on the kind and a truck sliding from 28% to
12% would otherwise reset its own timer by crossing a band and say it twice.

**Abnormal consumption needs a memory, and for the life of the feature it had
none.** `assessFuelRisk` has always carried the branch; its only caller handed
it `fuelPercent: null, odometerMiles: null` HARD-CODED, so the branch could not
run. `database/truckFuelReadings.js` and `truck_fuel_readings` (migration 0038)
close that: ONE ROW PER TRUCK, updated in place — about 110 rows forever, not a
position history, which this application deliberately does not keep.

The row carries a `baseline_*` triple that the comparison is made against, and
it advances only once real distance has accumulated. Comparing consecutive
20-minute samples measures noise; a 1% drop over 4 miles is a 25%-per-100-miles
burn rate made of rounding error. Three things RESET the baseline instead of
advancing it, and each is a case where burn measured across it would be a lie: a
refuel (fuel used across a fill-up is two different tanks), an odometer that
went backwards or jumped implausibly (a different vehicle now answers to this
unit number), and a baseline gone stale (parked, or the feed was down). The
comparison is therefore null far more often than not, and that is the design.

`/api/health → operations.fuel` publishes `comparable`: how many trucks have a
usable window. **Zero comparable trucks and zero findings are the same silence
and mean opposite things** — the first is a blind engine, the second a healthy
fleet — and before this block there was no way to tell them apart.

**New telemetry.** Samsara is now asked for `fuelPercents` and
`obdOdometerMeters` alongside `gps`, on the request that was already being made.
Factor and Leader have returned `fuel_level` and `odometer` in their documented
payload all along and nothing ever read them; both are now mapped through
`services/liveLocations/providers.js`. A vehicle that does not report them has
`null`, never `0`.

## Safety coach (every 6 hours, first pass 20 minutes after boot)

`services/safety/coach.js`. Reads safety events as a **pattern** rather than one
incident at a time, and says one useful thing to a driver who has a habit.

The events themselves are new. The Samsara poller has been formatting them,
sending them and throwing them away, so `driver_safety_events` (migration 0033,
written by `samsara-integration`) is the missing half. Every query groups by
`person_id`: a safety history that resets when a driver changes truck hides
exactly the driver a pattern would find.

**Two hard lines.**

*AI never decides whether a driver is coached, only how the sentence reads.* The
decision is arithmetic in `lib/safety/patterns.js`, which is pure and has no
model in it. With every provider dead, every driver who should be coached still
is, in a fixed sentence that names the habit, the count, the window and the one
thing that helps.

*Nothing here decides anything about a person's job.* No score, no ranking, no
fine, no recommendation. A model answer containing any of a broad list —
discipline, warning, points, score, probation, "your pay", "your job" — is
rejected and the fixed sentence is sent. The word "warning" is on that list in
every sense: "written warning" walked past an earlier list that only knew
"warning letter".

**One habit per pass**, the commonest. A message listing three faults is a
reprimand however warmly it is worded, and nobody changes three habits at once.
A habit coached in the last fortnight is not raised again; coaching one habit
does not silence a different one.

Samsara's four spellings of a behaviour (`HarshBraking`, `harsh_braking`,
`Harsh Braking`, `HARSH-BRAKING`) collapse to one. Counted separately each has
one event, nothing reaches a threshold, and the feature silently never fires.

A crash is never a coaching moment. It is an incident, and a person owns it.

Driver messages go through `homeTimeDriverChannel.sendToDriverGroup`, the one
choke point for everything said to a driver group, so the silent-mode switch
applies. When the driver cannot be reached the note goes to the operations chat
instead of nowhere. A heavy pattern is escalated to safety management with the
numbers that justified it, and says explicitly that no automatic action was
taken.

Visible on `/api/health` → `operations.safety`.

## Retention watch (every 4 hours, first pass 15 minutes after boot)

`services/retention/watch.js`. Scores every active driver from facts other
features already recorded, and posts to the `retention` notification category
when the score crosses a threshold. **Operations chat only — never the driver's
own.**

Deliberately slow. Nothing here is urgent in minutes: a driver five weeks past
the allowance will still be five weeks past it at teatime, and a slow timer is
the cheapest guard against the failure this feature is most likely to have,
which is saying too much.

**The decision is arithmetic** (`lib/retention/signals.js`, pure). With every
provider switched off the same drivers are flagged with the same reasons; AI
words one sentence and is given counts and reason phrases with no name and no
message text.

**A signal is something the COMPANY did or something the driver SAID** — weeks
past the allowance, a home window promised and missed, bonus earned and unpaid,
days sitting empty, a message that read as leaving. Never an assessment of the
driver. `refuseEmploymentLanguage` refuses a notice that strays, on the model's
output and again on the finished body.

Said once. Said again only when the score rises by 3 or more, or a week has
passed. An acknowledgement from Operations → Retention buys silence until it
gets materially worse — never indefinitely.

## The roster itself

Every job on this page is started and stopped in one place:
`services/backgroundServices.js`, split out of `index.js` when that passed the
size limit. It is a list of calls, not a framework, and the comment beside each
one says what that service may SEND — several can message a driver or spend
money. `tests/backgroundServices.test.js` asserts that everything started is
also stopped, which is the failure a split like that introduces quietly: a job
whose `start` moved and whose `stop` did not keeps running in a process that was
supposed to have gone away, and nothing fails.

What stayed in `index.js` is the process itself — the bot, the HTTP server, the
database, the leads child process and the memory watchdog — because the ordering
around those is boot sequencing rather than a roster.

## Self-healing watch (every 30 minutes, first pass 10 minutes after boot)

`services/operations/selfHealing.js`. **Adds no recovery.** Every recovery it
reports already ran silently — token refresh, provider cooldowns, model
retirement, outbox backoff. What was missing is the noticing, because "Wenze
fixed itself" and "Wenze has been broken for three days" look identical from
outside.

Nothing probes an external service; every observation reads what the application
already recorded about its last real attempts. A source that cannot be read is
**unknown, never failed**.

Four rules in `lib/operations/healthTransitions.js`, pure: three consecutive
failures before anything is said; **recovery announced only where the failure
was**, so a blip that self-corrects produces zero messages rather than one;
flapping said once and then silent; nothing said twice. `announced_status` is
stored rather than held in memory because Render deploys several times a day and
an in-memory version would re-announce every outage on each one.

Recovery → `self_healing`, and says nothing is needed. Failure and flapping →
`system_errors`, and say what does.

## Learning pass (every 12 hours, first pass 25 minutes after boot)

`services/operations/learningPass.js`. Notices that Wenze keeps being corrected
the same way — three reverts of the same `action_key` in a fortnight, or
repeated refusals of the same kind on recruiting drafts — and **proposes**
something about it to the `ai_learning` category.

**Nothing it produces takes effect.** `lib/operations/learning.js` returns plain
data with no function in it; the service stores and sends; the schema allows
`proposed`, `accepted`, `dismissed` and has no status meaning "applied
automatically". Accepting records that an administrator agrees — the change is
then made by hand. A decision holds: the next pass refreshes the evidence
without reopening the row.

Slow on purpose. A pattern needing three reverts in a fortnight does not become
visible in an hour, and a proposal about how Wenze should behave is the last
thing that should arrive often.
