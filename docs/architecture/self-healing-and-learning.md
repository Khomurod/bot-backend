# Self-healing, and learning from being corrected

**Read this before changing `lib/operations/healthTransitions.js`,
`lib/operations/learning.js`, or either service under
`services/operations/`.**

Related: [`operational-notifications.md`](operational-notifications.md) (the
three categories these use), [`ai-decisions.md`](ai-decisions.md).

---

# Part 1 — Self-healing

## This adds no recovery, and that is the point

Wenze already recovers from most of its own integration failures and always
has:

| Recovery | Where | How often |
|---|---|---|
| RingCentral refresh tokens rotated | `services/ringCentralTokenRefreshService.js` | daily, and at boot |
| An AI provider leaves cooldown | `lib/ai/cooldown.js` | on its own timer |
| A retired model dropped, the next promoted | `services/ai/discovery/modelMaintenance.js` | daily |
| A durable outbox backs off and retries | four queues | per attempt |
| A moved terms page rediscovered | `services/ai/policy/` | per check |

**Every one of those is silent.** So "Wenze fixed itself" and "Wenze has been
broken for three days" look identical from outside — and the second one is the
reason the first is worth saying out loud.

What was missing is the **noticing**. That is all this is.

## The whole difficulty is saying it rarely enough to be read

Four rules, in `lib/operations/healthTransitions.js` — pure, no database, no
clock of its own.

**1. A single failure says nothing.** Integrations blip; a provider 503s and the
next call succeeds. Nothing is announced until three consecutive failures.

**2. Recovery is announced only to people who were told about the failure.**
**If Wenze never said it broke, it does not say it healed.** A blip that
self-corrects inside the threshold produces **zero** messages, not one. Get this
backwards and the self-healing channel fills with recoveries from failures
nobody knew about, which is the fastest way to make a channel unread.

**3. A component that breaks and heals repeatedly is ONE problem.** Past four
transitions in six hours it is announced once as flapping and then goes quiet.
The recoveries are real but they are not news, and something that cannot stay up
needs a person rather than a commentary.

**4. Nothing is announced twice.** `announced_status` is the record of what the
readers were **last told**, which is a different thing from what is true now,
and it is what every suppression above is decided against. It is stored rather
than held in memory because Render deploys several times a day and an in-memory
version would re-announce every outage on each one.

## What is observed, and how

**Nothing probes an external service.** A health check that makes its own
requests is a new way to be rate limited, and a test asserts the file contains
no `fetch(`. Every observation reads what the application already recorded about
its last real attempts:

### It used to watch three things

Recruiter logins, AI providers and the notification queue — while **twenty-five
background workers and nine integrations ran beside them unobserved.** The
reason that gap was invisible is the same one this whole document keeps
returning to: a pass that finds nothing writes nothing, so a worker whose timer
was never armed and a worker that ran and had nothing to do produce identical
evidence. Three services kept a `lastRun` in **process memory**, which a Render
restart reset to `null` — indistinguishable from "this has never worked in its
life". The other twenty-two exposed nothing at all, and four of them built a
detailed per-pass summary that their `tick()` threw away.

### The run ledger

`background_service_runs` (migration 0039) holds **one row per worker**, updated
in place — about thirty rows forever, deliberately not a run history. A worker
joins it with one line:

```js
await withRunRecord('fuel_risk', () => runFuelRiskCheck({}));
```

`lib/operations/backgroundServiceCatalog.js` is the roster those keys are
checked against, and a test scans the source for every key any service actually
records under and fails if one is missing from it — an uncatalogued key gets a
null expected interval, which means staleness can never be decided for it, so it
would report healthy forever including after it stopped.

`last_status` is a closed vocabulary of four, and `blocked` is the interesting
one: a worker that cannot run until an operator configures something is **not
failing**, and painting it red is how a real outage gets lost among things
nobody ever switched on.

### Seven states

`lib/operations/runHealth.js` is pure and decides all of them.

| State | Means |
|---|---|
| `healthy` | ran, recently, without error |
| `degraded` | failed once or twice. Integrations blip; announcing this is how a channel becomes unread |
| `repeatedly_failing` | three or more in a row |
| `stale_stopped` | **has not finished a pass in several of its own intervals.** The one nothing else can see: not failing, not running, and every table it owns merely quiet |
| `recovered_automatically` | ran clean after failing — worth saying once, to people who were told it broke |
| `needs_human_attention` | blocked on configuration, or failing past the point where the automatic recovery has had its chance |
| `cannot_determine` | no record, or not due yet. **Never healthy** |

Staleness is checked **before** the status, deliberately: a worker that failed
once and then stopped ticking reads `error` forever, and the useful fact is that
nothing has run since.

### What each component's health is read from

| Component | Failing means |
|---|---|
| every catalogued worker | its ledger row, through `classifyRun` |
| `recruiter_logins` | **every** credentialed recruiter has `rc_auth_error`. One is a person's problem; all of them is an outage. None connected at all is `needs_human_attention` |
| `ai_providers` | **every** enabled provider is in cooldown. One is the router doing its job. None enabled is `needs_human_attention`, and says the consequence: every AI feature is on its deterministic fallback |
| `eld_location_freshness` | the newest row in `truck_fuel_readings` is over three hours old. One answer instead of four features going quiet separately |
| `telegram_delivery` | a notice has been pending over 90 minutes — not a slow queue, a queue nothing is taking from |
| `notifications` | any notice reached `abandoned` — the one failure that silences every other feature's alarm, which is how 101 staff alerts were lost once already |
| `samsara_safety_pipeline` | the poller's own heartbeat has gone stale. It is a **separate Render service** sharing only this database, so it writes one row into the same ledger; without it, a dead poller and a quiet week are the same empty safety table |

A source that cannot be read is **unknown, never failed**, and is dropped before
the announcer sees it so three unreadable passes cannot announce an outage that
was only ever a failing health query. "I could not check" is not "it is broken".

Recovery goes to `self_healing` and says **nothing is needed**. A failure and a
flap go to `system_errors` and say what does.

### Where an operator sees it

`/api/health → operations.workers` carries counts per state plus the components
that are actionable, each **named** with its reason — "3 needing attention"
without saying which three is a number nobody can act on. Admin → Operations →
**What is running** shows the same thing grouped by integration / queue / engine
/ routine, sorted so the rows with something to DO are first, with the reason as
the loudest text on the row: "no Google Maps key configured" is an instruction,
"failing" is not.

There is **no restart and no retry control**, deliberately. A button like that
is one somebody presses instead of finding out why, and every recovery this
system performs is already automatic and already announced.

---

# Part 2 — Learning from human corrections

## The signal is a human undoing something

It is the only feedback this application actually collects. Nobody fills in a
form saying "that was wrong"; they **revert the correction**, or they answer the
candidate themselves. `operational_corrections.reverted_at` and
`recruiting_ai_conversations.last_refusal_reason` are already written for other
reasons and are the whole input.

**One revert is not a lesson.** A person disagreeing about one row is usually
right about that row and nothing more. Three of the same `action_key` inside a
fortnight is the point at which "this check is wrong" becomes more likely than
"those three rows were unusual".

The humans' own reasons are carried **verbatim**. Three reverts that all say
"wrong truck" are a different suggestion from three that say nothing, and the
sentence somebody wrote when they were annoyed is the most useful thing in the
row.

## Nothing it produces takes effect

**This is the owner's line, and it is held in three places at once:**

1. `lib/operations/learning.js` returns **plain data** — a title, lines, a
   sentence and evidence. A test asserts none of its output is a function: a
   lesson cannot do anything.
2. `services/operations/learningPass.js` stores and sends. A test reads the file
   and asserts it calls nothing that could change a rule.
3. `operational_learning_suggestions.status` allows exactly `proposed`,
   `accepted`, `dismissed`. **There is no status meaning "applied
   automatically"**, and the API refuses one before SQL has to.

`accepted` records that an administrator agrees. Whatever the suggestion
proposed is then done **by hand, on purpose**. An endpoint that both proposed
and applied would make the confirmation a formality one careless click wide.

The suggestion itself is deliberately the conservative one: *switch automatic
correction off for this check and let it propose instead*. That costs nothing if
it is wrong and stops a wrong repair if it is right. *Change the rule* is the
expensive guess and is not the machine's to make.

A decision **holds**. The next pass finds the same pattern — because it is still
there — and refreshes the evidence without reopening the row. An administrator
meeting a dismissed proposal every fortnight is an administrator who stops
reading them.

## The second signal: refused recruiting drafts

A rising count of `unapproved_figure` refusals means something specific and
fixable: **candidates keep asking about something nobody has taught Wenze.**
That is not a defect in the guard, it is a gap in the knowledge base, and it is
the one suggestion here that a person can act on in a minute. A `commitment`
refusal reads the other way, and the suggestion says so.

## Schedules

| | |
|---|---|
| Self-healing | every 30 minutes, first pass 10 minutes after boot |
| Learning | every 12 hours, first pass 25 minutes after boot |

The learning pass is slow on purpose: a pattern needing three reverts in a
fortnight does not become visible in an hour, and a proposal about how Wenze
should behave is the last thing that should arrive often.

Both are on `/api/health` → `operations.systems` and `operations.learning`.

## Tests

```
node --test tests/healthTransitions.test.js   # 13 — the four rules, pure
node --test tests/selfHealing.test.js         # 14 — what is observed, and the silence
node --test tests/operationsLearning.test.js  # 17 — one revert is not a lesson
node --test tests/learningPass.test.js        # 13 — and it cannot apply anything
node --test tests/learningRoutes.test.js      # 8
TEST_DATABASE_URL=... node --test tests/selfHealingPg.test.js   # 11
npm test --prefix admin -- --run LearningTab                    # 8
```
