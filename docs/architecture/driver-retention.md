# Driver retention: what Wenze notices, and what it will never do

**Read this before changing anything under `lib/retention/`,
`services/retention/`, `database/retention*.js`, or the Retention tab.**

Related: [`operational-notifications.md`](operational-notifications.md) (where
the notice goes), [`ai-decisions.md`](ai-decisions.md) (what a model may
decide).

---

## The rule that shapes every other decision here

**A retention signal is something the company DID, or something the driver
SAID. It is never an assessment of the driver.**

That is not a nicety, and it is not only an ethical position. The obvious
implementation of "retention risk" scores how a driver *behaves* — how much they
complain, how often they are coached, how many loads they turn down — and what
that produces is a performance file nobody agreed to, assembled by a machine,
about people who cannot see it.

It would also be **useless**. A driver leaves because they have been out five
weeks and their home request expired unanswered. The actionable half of that
sentence is entirely the company's, and a score built from the driver's
behaviour would have found nothing to do about it.

So the signals are: promises not kept, money earned and not paid, time owed and
not given, and the driver's own words. Nothing else. `lib/retention/signals.js`
has no vocabulary for a judgement, and
`tests/retentionSignals.test.js` asserts that the rendered output contains no
word like *performance*, *attitude*, *unreliable* or *discipline*.

## What is scored

| Signal | Weight | Source |
|---|---|---|
| `quit_signal` | 6 | `chat_message_annotations.intent = 'quit_signal'` |
| `home_commitment_broken` | 4 | an approved home window not honoured |
| `home_request_unanswered` | 4 | `home_time_requests` ending `expired` / `clarification_unanswered` |
| `road_clock_over` | 3 | `driver_home_status.state_since` vs `road_allowance_weeks` |
| `bonus_unpaid` | 3 | `driver_road_history.bonus_posted_at IS NULL`; rejected/failed mileage bonuses |
| `home_request_denied` | 2 | `home_time_requests.status = 'denied'` |
| `raise_not_qualified` | 2 | `raise_round_picks.qualified = false` |
| `complaints` | 2 | `intent = 'complaint'`, 2 or more |
| `gone_quiet` | 2 | volume against **this driver's own** earlier baseline |
| `sitting_empty` | 2 | `load_lifecycle.phase = 'empty'` for 3+ days |
| `negative_sentiment` | 1 | mean `sentiment` ≤ −0.5 on the annotator's −2..+2 scale |

**Saying they are leaving is the heaviest single signal** because it is the only
one that is not an inference. Everything else is circumstance.

`watch` at 4, `urgent` at 8. Below 4, nothing is said at all — one declined home
request is a normal week, not a resignation.

### Silence is measured against the driver, not against the fleet

A driver who has never texted much is not a risk. One who wrote twenty messages
a month and has written none is a different fact entirely, and it is the only
one worth a signal. The baseline needs at least five messages before silence
means anything.

### The 30-day ceiling is not a choice

`chat_logs` is pruned hourly at 30 days (`services/schedulerService.js`), so
every signal drawn from what a driver **said** is bounded by that. A longer
window would not find older messages — it would find none, and report somebody
who has been complaining for two months as somebody who has gone quiet.

### Never measured is not neutral

`avg_sentiment` comes back **NULL** when nothing was annotated, and the scorer
leaves it alone. A driver whose messages were never processed has not been
measured, and scoring them as contented would be a fabricated fact.

## Where AI is, and is not

**The decision is arithmetic and has no model in it.** With every provider
switched off, exactly the same drivers are flagged with exactly the same
reasons; a test asserts the `lines` of the notice are byte-identical either way.

AI gets one job: the single sentence at the top of the notice. It is given
**counts and reason phrases only** — no driver name, no message text, no
location — and the `retention_summary` capability is marked `sendsRawText:
false` accordingly. Its output passes `refuseEmploymentLanguage` twice: once as
the router's `validate` (so a provider that strays loses its turn to the next
one) and once on the finished body, because a wording that must never ship is
not something to check in one place.

## Where the notice goes

The `retention` category, to the operations notification group — **never to the
driver's own chat**. `services/notifications/send.js` is the only send path
here and it cannot reach a driver group. A driver who received "we think you
might be about to quit" would be reading a message about a file they did not
know existed.

### One message for the cohort, a message of its own only for the urgent

Production answered this within half an hour of going live: **fifty drivers came
back at `watch` on a fleet of about a hundred and ten.** Truthfully — this fleet
really does have that many people past the road allowance with home requests
that expired — but fifty separate notices is not fifty times the information. It
is a channel nobody opens again, and it would have arrived the moment somebody
configured a destination.

So `urgent` gets its own message. Everybody at `watch` is summarised into one:
the worst five named with their top reason, the rest as a count, and a pointer
to the screen, which can sort and filter in ways a chat message cannot. Only the
named ones are stamped as told, so a driver who merely made the count can still
be named on a later pass.

### Said once, said again when it gets worse

A driver five weeks past the allowance is five weeks past the allowance on every
pass. `shouldNotify` in `database/retentionAssessments.js`:

- first time → say it
- score risen by 3 or more → say it again, because that is news
- same level, said within a week → silence
- **acknowledged** → silence, but only until the score rises 3 past what was
  acknowledged. An acknowledgement must not buy silence for a situation that is
  deteriorating.

## What the screen cannot do

Operations → Retention has exactly **two** endpoints: read the list, and say
"we know" about one. There is no note field, no rating, no dismissal, and no
control that touches anybody's employment. A screen that let a dispatcher file
an opinion would, within a month, be the performance record this whole design
avoids. `tests/retentionRoutes.test.js` reads the route file as text and asserts
the endpoint list is exactly those two.

## "Ran and found nobody" is not "never ran"

Both produce an empty `driver_retention_assessments` table, and only one of them
is good news. So the watch keeps its own last-run record — when it ran, how many
drivers it looked at, how many it flagged, and whether it crashed — and
`/api/health` → `operations.retention.watch` carries it beside the counts.

A background job whose failure looks identical to its success is the shape of
problem this whole phase exists to remove: the home-time outbox retried, backed
off, gave up, recorded the error and told nobody for months. Shipping another
one would be a poor joke.

## Known limits, stated rather than hidden

- **The mileage bonus has no identity link.** `mileage_bonus_notifications` is
  keyed on a normalised NAME — the one real-money table in this application with
  no group and no person. It is bridged through `mileage_bonus_progress.person_id`,
  so a driver with no person resolved yet contributes nothing from it.
  Under-counting is the right failure: a notice built on a name collision would
  name the wrong driver.
- **`home_commitment_broken` and `raise_not_qualified` are scored but not yet
  gathered.** Both need a per-cycle classification rather than a count, so
  `database/retention.js` returns 0 for them and the scorer handles them the
  moment a gatherer fills them in. They are in the table and in the tests so the
  shape cannot drift while they wait.
- There is **no payroll or deductions data** in this repository at all, so an
  unpaid-miles or deduction dispute is only visible through
  `intent = 'complaint'`.

## Tests

```
node --test tests/retentionSignals.test.js   # 17 — the scoring, and what it refuses to be
node --test tests/retentionWatch.test.js     # 15 — every gate, and the AI-off equivalence
node --test tests/retentionRoutes.test.js    # 7  — what the API cannot do
TEST_DATABASE_URL=... node --test tests/retentionPg.test.js   # 16
npm test --prefix admin -- --run RetentionTab                 # 8
```

Confirmed failing-first: the three employment-language tests against a disabled
guard. The Pg suite also caught a genuine error in the gathering query before it
could ship — `mileage_bonus_notifications` has no `group_id`, which is exactly
the class of thing a fake cannot find.
