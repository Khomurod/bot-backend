<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list. -->

# §7. Automatic and background behavior

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
| `services/homeTime/returnToRoadWatch.js` (`startReturnToRoadWatch`) | 12 min, first tick 4 min | Watches drivers who are at home and decides whether they went back to work — Datatruck load + truck movement. No driver at home means no provider call at all. Files a finding; the corrections pass applies the high-confidence ones |
| `roadBonusNotifierService` | 10 min (first tick +20s) | retry safety net for road-bonus summaries |
| `datatruckDocumentService` | `DATATRUCK_DOC_POLL_MINUTES` (15) | new BOL/POD → matching driver group, deduped |
| `duplicateUnitCheckService` | 15 min (first tick +90s) | duplicate-unit / name-mismatch reports, **and the only writer of `groups.samsara_vehicle_id`** |
| `modelMaintenance` (AI) | daily 06:00 UTC (first tick +3 min), plus a 5-min-debounced verification when the router is refused a model | re-reads each enabled provider's `/models`; retires what is gone, keeps the operator's order, fills from Wenze's picks; files a `discontinuation` finding and a plain-words Telegram line. A failed listing changes nothing |
| `consistencyService` | 15 min (first tick +120s) | one snapshot → every pure check → findings filed and cleared ones resolved — **then the permitted Tier-1 corrections are applied, in the same guarded run**. Default deny per check; the Findings card shows "Auto-applied N of M" |
| `routeControlService` (monitor) | settings-driven, floor 30s | destination completion + off-route warnings |
| `recruiterCallSyncService` | self-rescheduling `setTimeout` | RingCentral call-log sync |
| `ringCentralTokenRefreshService` | daily, plus once at boot | renews each recruiter's RingCentral OAuth login (refresh tokens expire in 7 days and rotate on use) and flags a dead grant as `rc_auth_error` |
| `facebookWebhookService` worker | drains on arrival; retry wakes on `next_retry_at`; 15 min idle sweep (was a 5s poll) | verified Meta webhook events with retry |
| `databaseUsageService` | 60s flush | persists the estimated monthly database transfer and logs once at 80/90/95% of the budget |
| `memoryWatchdog` | **off by default**; 15 min when on | heap/RSS pressure logging. Requires `MEMORY_WATCHDOG_ENABLED='true'`; `MEMORY_WATCHDOG_INTERVAL_MS` is clamped to ≥60s |
| Python leads child | supervised process | Meta + RingCentral webhook intake |
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
- **Only a board running AHEAD of the truck is a conflict.** A lagging board
  describes almost every delivered load and flagging it would make the check
  pure noise. A board claiming more than the coordinates support means somebody
  recorded work that has not happened, and everything downstream will believe it.

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

**New telemetry.** Samsara is now asked for `fuelPercents` and
`obdOdometerMeters` alongside `gps`, on the request that was already being made.
Factor and Leader have returned `fuel_level` and `odometer` in their documented
payload all along and nothing ever read them; both are now mapped through
`services/liveLocations/providers.js`. A vehicle that does not report them has
`null`, never `0`.
