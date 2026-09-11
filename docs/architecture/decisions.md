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
