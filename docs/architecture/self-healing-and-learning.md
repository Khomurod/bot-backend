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

| Component | Failing means |
|---|---|
| `recruiter_logins` | **every** credentialed recruiter has `rc_auth_error`. One is a person's problem; all of them is an outage |
| `ai_providers` | **every** enabled provider is in cooldown. One is the router doing its job |
| `notifications` | any notice reached `abandoned` — the one failure that silences every other feature's alarm, which is how 101 staff alerts were lost once already |

A source that cannot be read is **unknown, never failed**. "I could not check"
is not "it is broken", and the summary counts `unchecked` separately from `ok`
for the same reason: only one of them is reassuring.

Recovery goes to `self_healing` and says **nothing is needed**. A failure and a
flap go to `system_errors` and say what does.

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
