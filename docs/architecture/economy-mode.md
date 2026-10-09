# Economy mode — standing background work down until the database allowance resets

**Read this before** changing `lib/operations/economyMode.js`,
`services/operations/economy.js`, the `launchUnlessPaused` calls in
`services/backgroundServices.js`, or the economy guard at the top of
`withRunRecord` (`services/operations/runLedger.js`).

## Why it exists

October 2026. The hosted database (Supabase, Free plan, grace period over) had
used 4.81 of its 5 GB monthly egress with eleven days of the cycle left, while
the application spent 0.3–0.45 GB a day. Going over restricts the database
outright, so every feature stops, not just the costly ones. The owner chose
what keeps running until the allowance resets on the 20th. The largest measured
consumers were:

- BOL/POD forwarding, ~100 MB a day (every document in the window re-read every pass);
- load control, ~110 MB;
- the consistency sweep and the findings it re-writes, 60–120 MB;
- each driver message, ~5.7 KB of reads;
- the health endpoint's operations block together with the AI roster, 30–40 MB.

## The switch

`ECONOMY_MODE_UNTIL`, an ISO date-time in the environment. **Nothing else turns
it on.**

| Value | Meaning |
|---|---|
| unset, empty, `off` | OFF |
| not a date | OFF, and the boot log says why |
| in the past | OFF — economy mode has simply ended |
| more than 45 days after the process started | OFF, loudly, for the life of the process — a typo (2027 for 2026) would otherwise pause half the application for a year while nothing that would notice is running. Judged from the START, because judged from the moving clock the same typo would come of age 45 days before its date |
| otherwise | ON until that instant |

There is deliberately **no default date in the code**. A hidden date would make
the test suite's behaviour depend on the day it runs, and would pause features
on any deploy made before that day.

When the date passes, every held service **starts by itself** (one timer, armed
at boot). No deploy or restart is needed. To end it early, set the variable to
`off` or delete it; Render restarts the service on an environment change.

## Two ways a pass stands down

1. **A service whose every pass is paused is not started**
   (`launchUnlessPaused(['key'], () => startX())` in the roster). No timer, no
   wake, no listener: nothing that could reach the database. This matters
   because several services read their settings *before* `withRunRecord`. The
   terms watcher reads its schedule, and the model maintenance registers a
   refusal listener.
2. **A pass that shares a timer with work that keeps running is refused inside
   `withRunRecord`, before its first query.** The consistency tick also drains
   the notification queue. The scheduler also grades decisions. Holding those
   timers would stop the drain and the scheduled broadcasts. The refusal writes
   nothing, not even the start line.

At boot, each paused key gets **one** ledger line, `blocked: paused to save
database traffic until …`. The admin therefore shows "paused" rather than a
service that went quiet. `blocked` is the ledger's word for "not running by
configuration", never a failure.

## What stands down, in the owner's words

| Owner's list (2026-10-09) | Catalogue keys |
|---|---|
| BOL/POD forwarding | `datatruck_documents` |
| load control | `load_lifecycle` |
| automatic checks and questions | `consistency_sweep`, `contradiction_pass`, `control_ask_pass`, `control_daily_digest`, `self_healing`, `learning_pass`, `duplicate_unit_scan`, `decision_verification` |
| fuel | `fuel_risk`, `fuel_stop_alerts` |
| driver retention | `retention_watch`, `chat_annotation` |
| AI checks | `group_status_ai`, `ai_model_maintenance`, `ai_policy_watcher`, `safety_coach` |

**Kept running:**
- driver chats and home-time requests, with their reminders;
- Samsara (a separate service);
- Facebook and SMS leads, including the after-hours answers;
- money codes;
- scheduled broadcasts;
- the delivery of every notice;
- birthdays;
- the weekly raise review;
- bonuses;
- route control;
- ETA updates;
- return-to-road detection.

**Slowed:** the Dispatcher Board is read every **4 hours**, instead of every 5
minutes. It is not paused, because the Sunday raise review refuses a Board
older than 6 hours (`MAX_BOARD_AGE_HOURS`, `services/raise/boardRoster.js`), so
stopping the read would stop the review. A **failed** read retries at the
normal pace, because the review also refuses a Board whose last read failed,
however recent the snapshot before it. The home-in/home-out pass follows the
read. The Board's own configured interval still wins if it is slower.

**The health endpoint** skips its `operations` block and reports
`economy: { active, until }` instead. That block is dozens of reads per build,
and the cron pinger asks for it about 150 times a day.

## What the end of a pause looks like

- **BOL/POD.** Documents uploaded during the pause are forwarded late, and only
  those inside the lookback window (`DATATRUCK_DOC_LOOKBACK_DAYS`, default 7).
  Older ones are not forwarded automatically.
- **Findings and questions.** These resume on the first sweep. The owner's
  question budget (two a day) still applies, so a backlog cannot flood the
  notification group.
- **Home-in/home-out.** In economy mode these come from a Board up to 4 hours
  old, so a recorded arrival can be that much late.

## Must not break

- **It is not a throttle.** No query is ever refused for being over a budget.
  That rule (`docs/brief/database-transfer.md`) still holds: economy mode is a
  dated list of passes, chosen by a person.
- **Every paused key is actually stood down.** Each key is either held in the
  roster or run through `withRunRecord`; `tests/economyMode.test.js` greps both
  and fails on a key that is neither.
- **Nothing the owner kept is on the list.** The same test names them.
- **The consistency timer is never held**, because it delivers every notice.

Tests: `tests/economyMode.test.js` (the switch, the list, holding and
releasing, the roster) and `tests/economyModeWiring.test.js` (the ledger guard,
health, the pool, the AI roster).
