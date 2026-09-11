# How the background jobs behave — the rules they all share

Part of [`APP_BRIEF.md`](../../APP_BRIEF.md). Its sibling
[`background-jobs.md`](background-jobs.md) describes each job; this describes
what is true of ALL of them.

Split out when the two together passed this repository's 500-line limit, and the
line to split on was obvious: one document answers "what does the fuel watch
do", the other answers "how would I know whether it ran, and what did it cost".

---

## The fleet snapshot is fetched once a minute, not once per caller

`fetchAllVehicleStats` caches for 60 seconds, keyed by a **hash** of the API key
and base — never the key itself, which must not sit in a map key that could be
logged or dumped.

Route Control resolves each active assignment's GPS separately and each
resolution fetched the **entire paginated fleet**: ten active assignments meant
ten complete fetches every check interval, roughly fourteen thousand a day for a
hundred trucks whose positions were identical in all ten. The duplicate-unit
scan, the fuel watch and the load watch ask for the same snapshot on their own
timers as well.

Sixty seconds is shorter than every caller's interval, and the data is already
treated as approximate — nothing decides anything from a position without
checking its age, and `staleGpsMinutes` is measured in tens of minutes. Callers
arriving together **share one in-flight request** rather than making eight.

**A failed fetch is never cached.** Keeping the last good snapshot through a
blip would be worse than useless: a caller would read positions from before an
outage and believe them current.

## Data retention (hourly, on the scheduler's existing timer)

`services/operations/dataRetention.js`, called from `schedulerService`'s hourly
`retentionTick` rather than from a timer of its own — a second timer is a second
thing that can stop without anybody noticing.

It exists because an audit found prune functions **written and never called**:
`pruneOldSafetyEvents` has a 180-day window, a test and no caller outside tests;
`pruneAiCallLog`'s only caller was a test file. Several newer tables had no
prune at all — an operational notice per distinct notice key, a coaching row per
coached driver, and one `operational_findings` row per load order ever seen,
because resolving a finding updates its status and never deletes it.

| Table | Window | Only when |
|---|---|---|
| `driver_safety_events` | 180 d | — |
| `driver_safety_coaching` | 365 d | — |
| `ai_call_log` | 30 d | — |
| `operational_findings` | 60 d | `resolved`/`dismissed` **and** `resolved_at` set |
| `operational_notifications` | 90 d | `delivered`/`abandoned` |
| `duplicate_unit_reports` | 90 d | `resolved` |
| `service_runs` | 30 d | — |

**Age is not resolution.** An OPEN finding and a PENDING notice are never
deleted at any age: a finding nobody has dealt with in a year is a worse problem
than a large table, and removing it would hide the problem rather than solve it.
`operational_corrections` is never pruned either — it is the audit trail of
every change Wenze made to a real record and the only thing a revert can be
built from — and nothing that is a record about a PERSON is touched.

## Nothing is heard unless a destination is set — and the cost is counted

`notify()` discards a notice when no Telegram destination is configured. That is
deliberate: enqueuing them would mean that on the day somebody finally sets a
group, months of stale alerts flood a live staff chat, which this repository
explicitly refused to do with 98 expired home-time alerts.

**The cost of that decision was invisible**, and that is the same silence the
whole project started from, reached by a different route: production runs every
background feature, finds real things, and says nothing, behind a grey "not
configured" note on a settings page nobody has a reason to open.

So discards are **counted** — `notification_discards` (migration 0041), one row
per category, nine rows forever, no bodies and no subjects. "Not configured"
becomes "1,247 notices thrown away, 900 of them Needs attention", which is a
sentence somebody acts on. It shows on `/api/health →
operations.notifications.discarded`, in Settings → Notifications, and as a
`needs_human_attention` row in Operations → What is running, plus a banner on
the Operations page itself.

Settings → Notifications also **offers the chats this deployment already
messages** (`lib/notifications/candidates.js`) so that setting a destination
does not mean going to find a Telegram chat id. Offered, never applied: routing
safety escalations into the chat that receives survey results is an audience
decision, and picking one goes through the same validation as a typed id.

**`load_lifecycle` had no sender at all.** The category was configurable in the
admin from the day it was written and `lifecycleWatch` required `notify` in its
dependencies and never called it — a feature that looked wired up and was not.
It now announces a load whose sources genuinely CONTRADICT each other, once a
day per load. A merely unreadable load stays a finding.
`tests/notificationCoverage.test.js` reads the source and fails if any category
has no caller, which is how that was found.

## Every worker records that it ran

`services/operations/runLedger.js` wraps a pass in one line and
`background_service_runs` (migration 0039) keeps **one row per worker**, updated
in place. It exists because a pass that finds nothing writes nothing: a worker
whose timer was never armed and a worker that ran and had nothing to do produce
identical evidence everywhere else in this application. Three services kept a
`lastRun` in process memory, which a Render restart reset to `null` —
indistinguishable from "this has never worked".

`lib/operations/backgroundServiceCatalog.js` is the roster, and
`lib/operations/runHealth.js` turns a row into one of seven states. The one that
only exists here is `stale_stopped`: not failing, not running, every table it
owns merely quiet. `blocked` is configuration rather than failure, because an
unconfigured feature painted red is how a real outage gets lost among things
nobody switched on.

Seen at `/api/health → operations.workers` and in Admin → Operations → **What is
running**. Full rules in
[`docs/architecture/self-healing-and-learning.md`](../architecture/self-healing-and-learning.md).

**Three missing overlap guards were fixed at the same time.** `retention/watch`,
`operations/selfHealing` and `operations/learningPass` had no `tickRunning` at
all, and the consistency service's notification drain sat *outside* the guard
its sweep used — safe only because a database lease further down happened to
lock, which is not a property anybody can rely on while editing the thing
further down.
