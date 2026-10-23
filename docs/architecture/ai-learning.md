# Learning from the owner: questions when Wenze is not sure

> Read this before changing anything under `services/ai/learning/`,
> `lib/ai/lessons.js`, `database/aiLessons.js`, the `learning` argument a
> decision passes to `runCapability`, or the lessons block a prompt is given.

## What the owner asked for (23 October 2026)

When the free models and then Claude are still not sure how to read something
(`services/ai/escalation.js`, rule 7 of [`ai-decisions.md`](ai-decisions.md)),
Wenze asks the owner in the **system-notifications group**, and learns from the
answer:

- **in English, one question at a time** — the next goes out only after the
  last is answered or skipped;
- **no daily limit**;
- **answered in plain words, as a Telegram reply** — no buttons on these
  questions (the owner's words: "I just want to answer with text");
- Wenze says back what it understood — **"Understood: … Saved"** — and uses the
  answer in every later prompt for that kind of decision;
- the lessons are listed in the admin (**Settings → AI → What Wenze learned from
  you**) and can be removed there;
- accounting's reason for **"Not charging"** a home-time violation is learned
  from too.

The buttons that already exist stay: the control channel's Yes / No / Later
([`control-channel.md`](control-channel.md)), accounting's Charged / Not
charging ([`home-time-violation-alerts.md`](home-time-violation-alerts.md)),
Safety Approvals and the hiring-stage proposals.

## How a question is raised

A decision that wants the owner asked passes `learning` to `runCapability`:

```js
learning: {
  context: 'Safety replied "ok go" to a recruiter\'s post: "…"',  // what the owner is shown
  ask: 'What did Safety decide here, and how should I read replies like this?',
  subjectKey: 'chat:root',   // optional — the same thing is asked about once
}
```

Only when the **final** answer is `uncertain` — the free answer under 85% (or
"unclear", or no confidence) **and** Claude, or the strong fallback, still not
sure, or nobody better reachable — does `services/ai/learning/hooks.js`
`onUncertain` queue it. A caller that passes no `learning` is never asked about.
It is fire-and-forget: the decision returns exactly as it would have, and
queueing can never fail it.

Today three readers ask:

| Capability | Context shown | Asked once per |
|---|---|---|
| `safety_approval_reading` | Safety's reply and the start of the recruiter's post | the same reply text |
| `hiring_stage_reading` | the end of the candidate's conversation | candidate thread (`chat:root`) |
| `home_time_intent` (`homeTimeIntentService`) | the driver's message | that message (`group:message`) |

**Phone numbers are masked** to their last four digits (`maskPhones`) and the
excerpt is clipped to 500 characters before it reaches the group, which is for
staff, not for copying numbers around. The notice composer's own sanitiser
(`lib/notifications/compose.js`) still runs on top.

**Learning does not re-decide the case.** The decision that raised the question
has already done whatever an unsure answer does (Safety is asked, no stage is
proposed, the home-time gates decide). The lesson is for the next one.

## One at a time

`ai_learning_questions` (migration 0083) is the queue:

- `UNIQUE (capability, subject_key)` — a thread that keeps being unclear is one
  question, not one per message;
- `askNextQuestion` sends only while **no** question is `asked` and unanswered,
  the oldest queued first; `markAsked` moves only a `queued` row, so two passes
  cannot both send it;
- a send that reached nobody (no group configured, notifications off) puts the
  question back in line (`unmarkAsked`) instead of blocking everything behind it;
- it runs after a question is queued, after one is answered or skipped, and on
  the scheduler's hourly tick (`retentionTick`), which is what sends a question
  that could not go out when it was queued.

The notice goes through `notify()` — the one door — in category `ai_learning`
with subject `ai_learning_question:<id>`. It carries **no `question_json`**, so
the control channel's Yes / No / Later buttons are never attached and its
question counts (standing cap, daily budget, morning summary) never see it.

If the owner does not answer, nothing else is asked — that is the rule they set.
**Skip this question** on the admin card, or a reply of "skip", moves on.

## The answer

`bot/handlers/lessonReplyHandlers.js` → `services/ai/learning/answer.js`,
registered right after the control channel's handler (which passes the reply on,
since the notice has no `question_json`):

1. **shape** — a group, not a bot, a reply, some text; no database read otherwise;
2. **is it ours** — the replied-to message is a notice with subject
   `ai_learning_question`;
3. **who** — the control channel's allow-list, `control_operators`. Being in the
   group is not permission to teach Wenze; a stranger's reply is consumed and
   never acted on or answered;
4. **once** — `claimAnswer` moves the question only while it is `asked`, so a
   redelivered reply or a second operator writes nothing.

"skip", "pass", "next", "I don't know" skip it. Anything else becomes a lesson.

**A lesson is the person's own words.** `ai_lessons.statement` is exactly what
was typed, and it is what prompts are given. `understood_as` is a one-sentence
restatement by `lesson_restatement` (text for people; without a model it is the
owner's own words), shown back as "Understood: … Saved" and on the admin card —
**never** given to a prompt, so a model's paraphrase cannot quietly become the
rule. The same split as `recruiting_knowledge.statement` / `understood_as`
([`recruiting-knowledge.md`](recruiting-knowledge.md)).

## Accounting's "Not charging" reason

`bot/handlers/homeTimeViolationHandlers.js`, after the reason is written into
the alert, calls `services/ai/learning/accountingReasons.js`, which keeps it as
a `home_time` lesson with source `accounting_reason`. **The driver is not named
in the lesson** — what is worth learning is the kind of situation ("came home
early after 12 days on the road") and why it was let go; a name would carry a
person's private circumstances into every later prompt. The alert keeps the
name, as it always has. No model decides charging today; these lessons are
context for the home-time readers and are on the admin card with the rest.

## What a prompt is given

`runEscalated` asks `lessonsFor(capability)` for the **decisions only** (the
capabilities in `lib/ai/escalation.js` `ESCALATING`) and adds the block after
the caller's own instructions — as a system message when the caller sent
`messages`. `lib/ai/lessons.js` maps a capability to a scope (`home_time`,
`safety`, `hiring`, `driver_profiles`, `control`, `recruiting`); text written for
people takes none. The block lists the owner's answers first, then accounting's
reasons, newest first, at most 20, and says that lessons never override the
prompt's own rules.

The lessons are cached for five minutes per scope; adding or removing one clears
its scope at once in this process. A read that fails is cached as "no lessons"
for the same five minutes: an AI call never waits on, or fails because of, the
lessons table.

## Taking a lesson back

**Remove** on the admin card sets `removed_at` and `removed_by`; the row stays,
so "Wenze stopped doing X because of a lesson, removed on the 3rd" can still be
read. No prompt is given a removed lesson. The admin audit log records the
removal and every skip from the admin.

## The switch

**Settings → AI → Ask me when unsure** (`ai_settings.learning_enabled`, on by
default). Off: nothing is asked and nothing new is queued, so switching it back
on does not start with a backlog of stale questions; questions already queued
wait, and lessons already kept are still given to prompts. The master AI switch
off asks nothing either.

## Tests

`tests/aiLessons.test.js` (the words, masking, the prompt block),
`tests/aiLearningAnswer.test.js` (the reply gates, one at a time, skip, the
restatement fallback, accounting's reason, the hooks),
`tests/aiEscalation.test.js` (lessons in a decision's prompt and not in text for
people; the owner asked only when still unsure), `tests/aiLessonsPg.test.js`
(the queue, the claim, the soft removal, the switch — requires
`TEST_DATABASE_URL`), `admin/src/pages/settings/ai/LessonsCard.test.jsx`.
