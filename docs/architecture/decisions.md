# How Wenze decides, and what it writes down

Read this before changing anything under `lib/decisions/`,
`services/decisions/`, or the `operational_decisions` table.

## The principle

> AI may understand context and make recommendations. **Reliable operational
> evidence and approved business rules determine whether Wenze is allowed to
> act.**

That is a separation of powers, and each power has exactly one home:

| Power | Who holds it | Where |
|---|---|---|
| Understand, rank, explain, draft | AI | `services/ai/router.js`, per capability |
| Decide whether action is **possible** | deterministic evidence | `lib/decisions/verdict.js` (pure) |
| Decide whether action is **permitted** | the owner, per check | the check's mode |
| Record what was decided and what it cost | the journal | `operational_decisions` |

**Nothing a model returns may widen what the evidence permits.**
`tests/decisionVerdict.test.js` asserts this from the signature itself: the
function has no parameter named for a model, an override or a suggestion, and
passing such keys changes nothing. The same shape as `evaluateSuspension` in the
policy watcher, and for the same reason — a guarantee is worth more as a
signature than as a sentence somebody edits later.

## Four verdicts, and the two that look alike

| | |
|---|---|
| `act` | the evidence permits it and the mode allows it |
| `suggest` | the evidence permits it; a person decides |
| `hold` | the evidence is **against** acting. A real answer |
| `unknown` | the evidence is **missing**. Not an answer at all |

**`hold` and `unknown` are opposites, not neighbours on a scale.** Any model
that reduces confidence to one number collapses them, because both come out
low. "The truck is clearly still at the shipper" and "nobody has heard from this
truck since Tuesday" call for opposite actions. Conflating them is how a dead
feed becomes an inactivity report — a failure this application already has a
name for, and the reason `everything stale` returns `unknown` and never `hold`.

A confidence may never be attached to `unknown`. The data layer coerces it away
and the schema refuses it, because a number beside "I do not know" is one
somebody eventually compares against a threshold.

## What the evidence check actually does

Three conditions, each able to fail for its own reason:

1. **Something was read.** No sources → `unknown`.
2. **What was read is current.** All stale → `unknown`, never `hold`.
3. **The readings agree.** Disagreement → `hold`, never a guess.

Rule 3 is the loud one: when two sources contradict, the answer is **not** the
more confident source, it is that a person must look. Picking a side there is
what puts one driver's alert on another driver's phone. A source with
`agrees: null` has no opinion, and silence is not disagreement.

## A mode can only narrow

There is deliberately **no** path by which a mode turns `hold` or `unknown` into
`act`. A switch in an admin panel is permission to act on evidence that already
supports acting; it is not evidence. Autopilot on a check that cannot tell what
is true still does nothing. An unrecognised mode falls back to `suggest`, never
to autopilot — an unreadable setting must fail to the cautious side.

## Deciding and recording are one call

`services/decisions/journal.js` `takeDecision()` reaches the verdict and writes
it in the same call, and hands back **`mayAct`** — the only thing a caller
should ever branch on. It is true for exactly one verdict, in one mode, outside
shadow, and it is computed in one place so that "is this allowed" cannot drift
from "what was recorded".

They are not separable on purpose. Every defect this project has fixed had one
shape: two things that should agree, kept in step by nobody. A
decide-then-remember-to-journal pair would become that, and would fail in the
worst direction — the holds and the unknowns are the decisions a caller has no
other reason to write down, and they are exactly the ones outcome learning
needs.

A journal failure never breaks the pass it observes. The decision still stands
and the caller may still act; it simply was not written down.

## Who calls it

**Nobody did, for the whole life of this machinery.** `takeDecision` shipped
with nineteen passing tests and no production caller, so
`operational_decisions` was never written — and four stages of work hung off
that one missing call:

- the verification pass graded an empty table every hour and reported healthy;
- `sourceAgreement` had nothing to measure, so every source stayed unmeasured
  and the reliability model was decoration;
- the learning pass's third input was permanently empty;
- shadow mode counted what it would have done and recorded none of it.

The caller is `services/operations/corrections/decisionSeam.js`, used by the
auto-correction batch. Every planned correction now goes through it, *before*
the action runs, and the applied ones are stamped with their action and
correction id so the verification pass has something to grade.

### Routing corrections through the journal must not stop them

A safety feature that silently disables a working repair is a regression in
better clothes. The floor is 70, and the margin is smaller than the raw
confidences suggest, because each single-source decision loses 10 to
`weighConfidence`:

| check | files at | after weighing |
|---|---|---|
| `home_time.returned_to_road` | 85 | **75** ← tightest |
| `identity.group_without_person` | 90 | 80 |
| `identity.stale_unit_assignment` | 90 | 80 |
| `home_time.ghost_home_status` | 90 | 80 |
| `home_time.closable_open_cycle` | 90 / 95 | 80 / 85 |
| `identity.status_disagreement` | 95 | 85 |
| `home_time.exhausted_internal_alerts` | 100 | 90 |

Nothing that works today stops working. **Raising the floor without re-reading
that table is how the fleet stops being repaired.**

One behaviour did change deliberately: a finding with **no** confidence is
`unknown`, not low, and is held. `confidence` is nullable, so a check that
stops scoring can no longer keep changing rows on evidence nobody graded. A
held correction is not lost — the finding stays open on Needs Attention and a
person can still apply it by hand, since that route does not come through here.
`held` is counted apart from `disabled`: "the owner has not enabled this" and
"the owner enabled it and the evidence did not support it" are different
sentences.

A journal that cannot be reached does not block a repair either. The guardrails
that actually protect the fleet — per-check permission, the cap, and the
action's own re-derivation under `FOR UPDATE` — all still hold, and a database
blip switching off every automatic repair would be worse than an unrecorded one.

## Why the table is bounded

A row per decision per pass was **costed before it was written**: the load watch
alone re-decides 235 loads every ten minutes, and the whole set comes to about
44,000 rows a day — 16 million in a year, on free infrastructure, to say the
same thing repeatedly.

The key is `(check_key, subject_type, subject_id, verdict)`. The same verdict
recurring counts itself in one row; a **change** of verdict writes another,
because a load that flipped between `act` and `hold` five times is the single
most useful thing this table can say. The ceiling is roughly thirty-four checks
× a few hundred subjects × four verdicts.

This was learned the hard way one table over: migration 0041's discard counter
shipped counting passes rather than problems and reached 162 counts for about
60 distinct things within twenty minutes of deploying. Migration 0042 fixed it.
0043 was written with that fresh.

## What a reading is worth

`lib/decisions/sources.js` weighs the evidence before the verdict reads it, and
the rule that shapes it is an asymmetry: **evidence quality may only LOWER a
confidence, never raise one.** There is no path by which stacking more sources,
or sources that have been right before, pushes a rule past the number its own
logic reached. A system that could talk itself up would eventually act on five
weak agreements the way it acts on one strong one — and five sources reading the
same stale feed are not five pieces of evidence, they are one counted five times.

Three things are measured, and they answer different questions:

| | |
|---|---|
| **freshness** | was this reading current enough for **this** question? The window is the caller's to name: a position goes stale in minutes, a home-time request in days, and one constant cannot serve both |
| **thinness** | how much was actually read? One source agreeing with itself is not corroboration |
| **reliability** | has this source been right **before**? Measured from the journal's own graded outcomes, never assumed |

**A reading with no timestamp is not fresh.** It might well be current; we
cannot say so, and "cannot say" has to travel as not-fresh or a caller silently
treats an undated reading as a current one.

**An unmeasured source is not an unreliable one.** A source with no track record
is used at full weight; only a *measured* bad record discounts. "We have never
checked" and "we checked and it was wrong" are different facts, and the first
must not be punished like the second — the same distinction `unknown` and `hold`
draw. A reliability lookup that throws returns an empty record, which costs every
source nothing: failing closed there would quietly discount every source in the
application the first time that query broke.

### The floor, which is not a penalty

When the **only** thing speaking for an action is a source measured as usually
wrong, the verdict is `hold` regardless of the number. That is separate from the
confidence penalty on purpose: lowering a number is a judgement that can still
clear a threshold, and this is a floor. An absence of evidence must not be
lowered into acceptability by a generous threshold.

### The feedback loop

`sourceAgreement()` reads how each source actually performed, counting only
outcomes that are **a judgement about the source**: `confirmed`,
`contradicted`, `reverted`. The last two both mean "the outcome did not bear
this out"; separating them would imply a distinction the caller cannot act on.
It is empty until decisions have been graded, and an empty record is the
intended starting state rather than a degraded one.

### `not_checked` is not evidence against a source

This is the `hold` / `unknown` distinction from the top of this document, one
layer down and applied to outcomes. **"We could not check" and "we checked and
it was wrong" are opposites.** `not_checked` means nothing here knows how to
verify that action; `expired` means the subject is gone or too much time has
passed to judge. Neither is a verdict on the source, so neither is counted.

**This was not hypothetical, and it was the most dangerous defect in this
work.** The query counted every non-null outcome as graded and only `confirmed`
as success. Five of the seven actions that can run have no verifier in
`verifyPass.js`'s `SUBJECTS`, so each recorded `not_checked`. At five of them a
check's source crosses `MIN_GRADED` at 0% agreement, `soleSourceIsUnreliable`
fires — the correction seam cites exactly one source — and **every later
correction from that check is held for ever.** Automatic repair would have
stopped across most of the fleet, quietly, a few hours after the journal was
first given a caller.

The other half of the answer is to write the missing verifiers, which would turn
those `not_checked` rows into real judgements. Until somebody does, the rule
above is what keeps a missing verifier from being read as a failing check.

The weighing's reasons travel **with** the decision, so one read back months
later says why its confidence was what it was rather than only what it was.

## Going back to see whether it held

`services/decisions/verifyPass.js` runs on the scheduler's existing hourly tick
— riding that timer rather than arming its own, because a second timer is a
second thing that can stop without anybody noticing.

**This is what makes the track record real.** Nothing else ever sets an outcome,
so without this pass every source stays unmeasured for ever and the reliability
model above is decoration.

It asks **one narrow question**: are the values this correction wrote still
there? It does not re-run the check and does not form a new opinion about the
subject — anything broader would be a second decision engine, disagreeing with
the first at a different hour of the day.

| | |
|---|---|
| `confirmed` | what we wrote is still there |
| `contradicted` | it is no longer true |
| `expired` | the subject is gone |
| `not_checked` | nothing knows how to verify this action — an **honest** answer |

`not_checked` matters more than it looks. Grading an unverifiable action
`confirmed` because nothing objected would manufacture a track record out of
nothing, and the reliability model reads exactly that record.

Without a database the pass reports `blocked`, never a quiet success: grading
anything from the decision's own memory is the one thing it exists to avoid.

### Automatic rollback: built, guarded, and not reachable yet

`shouldRollBack` requires four conditions together — the outcome is
`contradicted`, **nobody else changed it**, the action declares itself safe, and
it has not already been reverted.

**No automatic rollback can fire today, and that is stated rather than left to
be discovered.** `compareWritten` can only reach `contradicted` by finding a
value different from the one we wrote, and it cannot tell *who* changed it — so
it says `someone`, and the guard refuses. The one contradiction this pass can
detect is the one it must never undo: reverting there would mean software and a
person taking turns overwriting each other, and the software would win because
it never gets bored.

The guard stays because its case is real and simply not detectable yet — a
correction whose values are intact but whose justifying evidence has evaporated.
Detecting that means re-deriving the evidence, which is out of scope here.

`SUBJECTS` also declares `autoRevert: false` for **every** action, deliberately:
each changes operational state about a real driver, and an automatic undo is a
second unattended write on top of the first. Turning one on is one word, and
should be somebody's decision with the comment in front of them.

A path that *looks* live and is not is the defect this repository keeps finding.
One documented as not-yet-reachable is a foundation.

## Outcomes are graded by somebody else

`outcome` is filled by the verification pass, never by the decider — a decision
that graded its own homework would be worth nothing. The vocabulary is closed
(`confirmed`, `contradicted`, `reverted`, `expired`, `not_checked`) so a summary
cannot grow a category nobody defined.

The prune keeps an action that was never graded **longer** than anything else:
it is the one record whose absence would hide a question.

## What it never stores

No message bodies, no driver names, no phone numbers, no chat ids, no API keys.
A decision points at a subject and, when it is about somebody, at a `person_id`
— the person layer holds the identity and this table holds the reasoning.
