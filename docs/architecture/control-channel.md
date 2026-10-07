# The notification group as a control channel

**Read this before changing anything under `lib/control/`, `services/control/`,
`bot/controlReplyHandlers.js`, or the question path in
`services/notifications/send.js`.**

Wenze finds things and says them into a Telegram group, and until now that is
where the conversation stopped. An owner who read "unit 001 is on three groups"
had to open the admin, find the finding and act on it there — so mostly nobody
did, and a finding nobody answers is a finding nobody filed.

This makes the notice itself answerable. Wenze asks a question in the group, the
owner **replies to that message** in ordinary words, and Wenze acts on the
reply, records it, and closes the finding.

## The hard rules

### 1. A reply may only choose an action the question offered

Not an action the words imply. Not an action that sounds right. One of the keys
in the notice's own `question_json.offeredActions`, written by Wenze when it
asked.

This is checked **twice**, deliberately: in `lib/control/intent.js` (an intent
whose action was not offered comes back `unclear`, `note: 'not offered'`) and
again in `services/control/actions.js` before anything is written. Two readers
of one rule is the point, not a duplication — the parser can be replaced, and
the writer must still refuse.

The consequence: **the visible text of a question never names an action key.**
If it did, a sentence in a group chat could quote it, and the text would be
naming the operation. `tests/controlQuestion.test.js` asserts the absence.

### 2. Being in the group is not authorisation

A Telegram group contains whoever was ever added to it — dispatchers, a second
account, a bot, somebody who left the company but not the chat. `control_operators`
is the allow-list, seeded by migration 0048 with `CREATOR_USER_ID` from
`bot/creatorMessageManager.js` and nobody else. Telegram's own admin flags are
**not** the gate: being able to pin a message is not the same as being allowed
to change who is assigned to a truck.

A reply from somebody not on the list is **recorded and never answered**.
Recorded because "a stranger answered an operational question" deserves a trace;
never answered because telling them their reply was read is an invitation.

The last enabled operator **cannot** be removed. An empty list does not mean
"everybody" — it means nobody can steer Wenze from Telegram and the way back is
the database. Enforced in `database/controlOperators.js`, so it holds for every
caller, and repeated in the route as the message a person reads.

### 3. A redelivered reply applies nothing twice

Telegram can deliver the same update twice, and the bot restarts several times a
day. `control_replies` carries `UNIQUE (chat_id, reply_message_id)` and
`recordReply` claims it **before** anything is acted on — the same ordering the
notification outbox uses when it counts an attempt at claim time. A null return
is not an error: it means somebody already has this reply, and the caller stops.

### 4. The runtime bot never touches source code

A code-level complaint becomes a recorded `engineering_request` for a person.
Nothing in `lib/control/`, `services/control/` or `bot/controlReplyHandlers.js`
imports the filesystem, a process, the network or `vm`, and
`tests/controlNoCodeAccess.test.js` asserts that structurally — including a
closed allow-list of what `services/control/actions.js` may import at all.

### 5. A model may read a sentence; it may never decide or write

The deterministic reader runs first, always. `parseIntent` is pure, has no
parameter through which a model could arrive, and a test asserts its signature —
so nearly every reply is decided with no model involved at all.

`services/control/aiIntent.js` (B2) is reached **only** when that returns
`unclear`, and four things bound it:

1. it may pick only from the keys the question already offered, plus
   `engineering_request` and `unclear`;
2. that is checked twice — as the router's `validate`, so a straying provider
   loses its turn to the next one, and again on the finished object here;
3. it supplies **no values**: no truck, no person, no date. Nothing it returns
   can land in a driver's record;
4. no provider, a switched-off capability, malformed JSON or an unoffered action
   all mean `unclear`. The question stands; nothing is guessed.

`tests/controlNoCodeAccess.test.js` asserts structurally that the deterministic
parser, the fingerprint, the writer and the memory contain no AI seam at all,
and that the reply handler reaches a model only through that one module — never a
provider client directly, which would route around the capability switch, the
cooldowns and the call log.

### 6. A remembered answer is bound to the CONDITION, and a remembered yes never acts

See **Remembering** below. Both halves are load-bearing and both are proved by
removal in `tests/controlFingerprint.test.js` and `tests/controlKnowledgePg.test.js`.

## The gates, in order

`services/control/replyHandler.js`, cheapest first, so a group full of ordinary
chatter costs almost nothing:

| # | Gate | What it rejects |
|---|---|---|
| 1 | shape | not a group, from a bot, not a reply, no text — **no database read at all** |
| 2 | is it ours | the replied-to message is not a notice of ours carrying a question |
| 3 | switched off | `control_settings.enabled = false` → recorded, silent |
| 4 | who | not on the allow-list → recorded `ignored_unauthorised`, never answered |
| 5 | redelivery | `recordReply` returned null |
| 6 | still open | the finding is re-read **live**; somebody may have fixed it in the admin |
| 7 | meaning | `parseIntent` first; only an `unclear` reaches `aiIntent`, which may still only choose what was offered |
| 8 | do it | `executeOffered`, the only writer — then a "no" is remembered |

### When Wenze comes back with a question

Two cases, both bounded by `control_settings.clarify_limit` (default 1) and both
counted on the notice itself (`clarify_round`), so a clarification that is itself
unanswered cannot start a third round:

- the reply was not understood, by the rules or by the model;
- the reply was a bare "no". A finding closed with no reason recorded is a
  decision nobody can review later, so Wenze asks why once and then takes the
  default reason rather than nagging.

**A clarification is sent as a real question, not as a plain message.** The reply
path only recognises an answer to a message carrying a `question_json`, so a bare
"why?" would be a dead end and the owner's explanation would be read as ordinary
chatter and lost. It is pinned under their own message (`inReplyTo`).

Three things make the conversation actually work, and each was a defect before it
was a rule:

- **The follow-up says what it is asking FOR** (`question_json.pending`). The
  answer to "why?" is a reason, not a yes/no/later — "he is a team driver" matches
  none of the parser's rules, and with no model available it would read as
  unclear, stand down at the clarify limit, and throw away the very thing that
  was asked for. When `pending.action` is `dismiss`, the reply IS the reason.
- **`parent_notice_id` always names the ROOT**, never the immediate parent, so a
  chain of any depth closes in two marks rather than a walk.
- **Answering a clarification closes the question that started it.**
  `countUnansweredQuestions` counts every unanswered notice carrying a question,
  so a parent left open burns a standing-cap slot for the whole repeat window —
  five such conversations and the ask pass sends nothing at all, with every
  visible question answered. `markNoticeAnswered` is idempotent (`answered_at IS
  NULL` is in its WHERE clause), so marking both is safe.

## Remembering

`control_knowledge` (migration 0050) is what stops the owner answering the same
question every week. The sweep re-derives a condition on every pass and files it
with a NEW finding id, so a finding's own `status` cannot carry an answer
forward.

**The memory is keyed on `(check_key, subject_type, subject_id)` and bound to the
condition by `evidence_fingerprint`.** `lib/control/fingerprint.js` hashes only
the fields that DEFINE each situation — `CONDITION_FIELDS`, one closed list per
check. Change the truck, the other holder, the direction of the disagreement, and
the fingerprint changes, the memory does not match, and Wenze asks again. Change
nothing but the finding's id, its timestamps or the wording of its title, and the
memory holds.

Hashing the whole evidence object would have been easier and wrong twice over: it
carries fields that move on every sweep (so no memory would ever match, and the
feature would silently do nothing) and display names that can be edited (so
renaming a chat would re-ask a settled question). **A check absent from
`CONDITION_FIELDS` is not rememberable** — it is asked every time, which is noisy
and honest.

| Answer | Written? | Acted on by itself? |
|---|---|---|
| `dismiss` | always | **yes** — the ask pass closes a re-opened matching finding, quoting the owner's words, and counts `times_applied` |
| `approve` | only with "always"/"don't ask again" | **never** |
| `snooze` | no | no — "later" is a delay, and the finding's own snooze window holds it |

**A remembered `approve` is never re-applied.** The owner approved ONE case, not
a standing permission; standing permissions live in
`operational_check_settings.mode`, where they are visible on a screen and can be
switched off. Applying one from a chat reply would be autopilot through a side
door. It is still recorded, because "you have said yes to this three times" is
what B3's learning pass reads when it suggests autopilot — a suggestion a person
accepts on a screen.

A memory is taken back, never deleted: `revoked_at` is set and the row stays, so
"Wenze stopped asking because you said X, and you withdrew that on the 3rd" is
still readable. Settings → Answering Wenze in Telegram lists what is remembered
with a **Forget** button; the finding's own detail panel shows the Telegram
conversation and the standing answer beside it.

**Every reader applies `memoryApplies`, not just the sweep.** A row keyed on the
subject is not proof that it answers the condition on the screen now — the
finding detail endpoint checks the fingerprint too, or it would tell an
administrator Wenze is remembering something it is not and offer them a Forget
button for an answer about a different situation.

## Asking

`services/control/askPass.js` rides the consistency sweep's timer (after the
contradiction pass, before the notification drain) under
`withRunRecord('control_ask_pass')`.

**Askable** is a closed definition:

- tier `auto` whose check is in `suggest` mode — Wenze *could* do it, the owner
  has not said it may, so asking is exactly right;
- tier `approval` with a registered action — a person was always required.

A `warning`-tier finding is **never** a question: there is nothing to approve,
and a question with no action behind it is a notification wearing a question
mark.

Five guards keep it from becoming noise, which is the failure mode that ends
with the group muted:

- **a standing cap on UNANSWERED questions.** This is the one that matters
  most, and it is not the same as the per-pass cap. The per-pass cap limits one
  pass; the sweep runs every fifteen minutes, so five a pass is four hundred and
  eighty a day, and the first day after a deploy would bury the owner in
  questions they have answered none of. While `max_questions_per_pass`
  questions are already out and unanswered (within `repeat_after_hours`), the
  pass asks nothing at all — the queue drains at the speed somebody actually
  answers it. A **failed** count means silence, not permission to ask more;
- **a DAILY budget, `max_questions_per_day` (default 2)** — the owner's "one or
  two important questions a day" (2026-10-06; migration 0067). Counted from the
  first questions that actually reached the chat in the last 24 hours
  (`countQuestionsAskedSince`), so restarts and fifteen-minute passes cannot add
  up to more; a count that failed is a spent budget. 0 asks nothing;
- `max_questions_per_pass` (default 5), **most important first**
  (`lib/control/priority.js`): money (a held road bonus) before anything,
  then serious, then warning, each oldest first. Strictly oldest-first spent
  the day's budget on whatever had waited longest. The order is applied in
  SQL before the scan limit (`listFindings({ order: 'ask' })`) — with 400+
  open findings, sorting a page cut by "most recently seen" could leave the
  held bonus off it;
- **every question says why it is asked** — "Why I'm asking: …", the
  finding's own reason when it has one, otherwise what its tier means;
- `repeat_after_hours` (default 72) — the same question is not re-asked inside
  the window. A **failed** suppression read means silence, not a second
  question;
- a wording entry in `lib/control/askable.js` is required. A check with none
  never asks — so a new check cannot start questioning the owner merely because
  somebody registered an action for it;
- one question per finding at a time.

**The ask is journalled as a suggestion before it is sent.** This is what
finally writes `suggest` rows to `operational_decisions`: until now the journal
recorded what Wenze *did* and was silent about what it wanted to do, because a
check in `suggest` mode never reached `takeDecision` at all.

### The notice key

`needs_attention:control_question:<findingId>:r<round>`, where `round` counts
full `repeat_after_hours` windows since the finding was first seen. The round
exists because the notice key is UNIQUE: without a part that changes, a
legitimate re-ask would be swallowed by the outbox's own dedup, silently, and
look exactly like suppression working. The trailing colon in the suppression
prefix is load-bearing — without it finding 4 suppresses finding 42.

## Answering

`notify()` gained `question`, `findingId` and `inReplyTo`.

`inReplyTo` **overrides category routing** — the one documented exception to
`docs/architecture/operational-notifications.md`. An answer belongs under the
question, in the chat somebody is reading; routing it by category would answer
an owner's "yes" in a different room, and Telegram would refuse the reply
anyway, since `reply_to_message_id` only resolves within its own chat.

When the target message is gone (deleted, or too old for Telegram to resolve),
`deliverOne` retries **once, unthreaded**. The words still reach the person; they
just do not hang under the question. Any other send failure is still a failure.

## Buttons

Every question goes out with **Yes / No / Later** buttons under it — only the
answers it offered, so a question with nothing to apply shows No and Later.
Production, 2026-10-02: fifteen questions asked, none answered. A typed reply
is long-press, Reply, type; a button is one tap.

**A tap is the word it stands for.** `lib/control/buttons.js` turns the button
back into `yes`, `no` or `later`, and `services/control/answerQuestion.js` —
the same code a typed reply reaches after its own gates — parses and acts on
it. There is no second rulebook for buttons, so a button can never do anything
the word would not. "No" still asks why (the follow-up hangs under the
question, with buttons of its own); "No" on the "why?" closes it with the
default reason, exactly as a second bare "no" does.

**What a button carries:** `ctl:<notice id>:<a|d|s>` — never an action key,
never a finding id. `buttonHandler.js` refuses a tap whose notice id is not the
notice the button is actually attached to, and an action the question did not
offer.

**One owner answer per question.** An operator's tap claims
`(chat, the question's own message id)` in `control_replies`, so a double tap,
or a second operator a second later, finds it taken and is told "already
answered" (a typed reply can still change it). A **stranger's** tap is recorded
under the **negated** message id instead: it leaves a trace and can never take
the claim the owner's tap needs — otherwise whoever tapped first would decide
whether the owner could answer at all. A stranger is answered with an empty
toast, the same silence a stranger's typed reply gets.

Once a question has an answer its buttons come off (`editMessageReplyMarkup`),
so nobody taps something already settled. A question answered **in words**
keeps its buttons on screen — the typed path cannot remove them — so a tap on
a notice that already has `answered_at` is refused ("already answered") and
takes them off then. Without that, a typed "later" (which leaves the finding
open) followed by a tap on the stale Yes would have applied the correction. The handler is registered with
`bot.action` before the survey handler's `callback_query` catch-all, and
`tests/controlHandlerRegistration.test.js` asserts the order.

## Attribution

`initiatorFor` in `services/operations/corrections/apply.js` learned a third
form: `telegram:<id>`, between `admin:<id>` and the `system` fallback.

This is not cosmetic. The schema's
`operational_corrections_system_is_auto_only` CHECK refuses an approval-tier
correction whose initiator is `system`, so without the branch an owner's "yes"
would fall through to `system` and be refused — the owner would have answered a
question Wenze then could not act on. `tests/controlChannelPg.test.js` drives
both halves against the real constraint.

## "The question itself is wrong"

An `engineering_request` intent — "this is a bug", "why are you even asking me
this", "the truck numbers come from the wrong place" — is the most valuable
thing anybody says to this application, and B1 dropped it: acknowledged
politely, and forgotten.

It now becomes a row in `engineering_requests` (migration 0051), a warning-tier
`engineering.request_open` finding on Needs Attention, and an ack naming its
number so the owner can see it went somewhere. It resolves when a person marks
the request accepted, done or declined.

**No column in that table can hold code or a file path**, and no correction is
registered for the check. There is no automatic answer to "the software is
wrong" — the resolution is a person writing code. See
`docs/architecture/self-healing-and-learning.md` → Part 4.

## Asking about what it decided NOT to do

A check on autopilot can still decide `hold` or `unknown`. Before B3 nothing
told anybody: the finding stayed open, the mode was not `suggest`, and the ask
pass skipped it — the owner granted autonomy and got silence.
`operationalDecisions.currentHolds()` now makes those askable whatever the mode,
and the question says **why** in plain words. The journal's own reason names a
check key and may never travel into a chat; `heldLineFor` maps its shape to one
sentence instead.

## The morning summary

Once a day, from 08:00 Chicago time, one message in the `needs_attention`
group (`services/control/dailyDigest.js`, pure wording in
`lib/control/digest.js`, rides the consistency sweep under
`withRunRecord('control_daily_digest')`):

- **"Most important today", first** — three of the open problems, chosen
  from the first eight by rule (`lib/control/priorities.js`, the same order as
  the questions). An AI (`daily_priorities`) may pick among them and say each
  plainly; every pick must name an item it was given, by number, so it cannot
  add a problem; and it must give exactly three (or all, when fewer are
  open) — an incomplete answer is refused. Without AI, or on a refused
  answer, it is the first three by rule under their own titles;
- **the questions still waiting** — how many, and the three that have waited
  longest by name and age. This is the escalation: a question nobody answered
  slides up the chat and is, in practice, gone; the summary brings it back.
  One per finding (a re-ask is not a second thing waiting), first questions
  only (a "why?" belongs to its question), delivered, unanswered, about a
  finding still open and not snoozed (`database/controlDigest.js`) — and
  **only questions asked in the chat the summary is going to**. A question
  keeps the chat it was asked in; after the destination changes, naming the
  old ones would show finding titles to a group that never received them. The
  destination is resolved exactly as `notify` resolves it; with none, nothing
  is read or sent;
- what Wenze changed on its own in the last day, and how many of **those**
  were undone (`revertedBySystem` — a person's undone edit is not counted
  against Wenze);
- how many problems are open (serious · warnings);
- which workers are broken, and separately which are switched off or waiting
  on a setting (`waiting`, never in `down`) — by catalogue label, never a key.
  "All systems running" is said only when both lists are empty.

**Once a day is the outbox's guarantee.** The local date is the notice's
discriminator, so the UNIQUE notice key refuses a second summary that day
whatever restarts. Before building it the pass checks that key with
`noticeSentWithin`, and a failed check counts as "already sent". Not after
20:00: a process down all day must not post the morning summary at midnight.

**Unread is never empty.** Each part reads independently; one that fails is
named in a closing "Could not read …" line instead of being reported as
"no questions" or "all systems running". The summary carries no question and
no buttons, and is off whenever the control channel is off.

## What the control channel deliberately does NOT do

- auto-apply a remembered `approve`. That would be autopilot through a side
  door, and it stays refused;
- propose that a check be put on autopilot. A run of approvals produces words
  with no button — see `ai-decisions.md` rule 5;
- act on an engineering request in any way. It is a row and an ack.

## Reading it from outside

`/api/health` → `operations.control`, counts only — no chat id, no operator id,
no text:

```
enabled     is the channel switched on
operators   HOW MANY may be obeyed. Switched on with an empty allow-list is a
            channel that obeys nobody, and it looks identical to a working one
            from everywhere else on this endpoint.
questions   asked · delivered · answered · outstanding · lastAskedAt
remembered  live · revoked · applied · lastAppliedAt
total/refused/last7d/lastAt   the replies
```

`remembered.applied` is the number that says the memory is doing anything: a
`live` count that grows while `applied` stays at zero means the fingerprints
never match, which from every other angle looks exactly like a quiet week.

**`questions` and the replies answer different questions, and the first was
missing.** Zero replies reads exactly the same whether five questions went out
and nobody answered, or none were ever sent — and those need opposite responses
from whoever is reading this. `delivered` is the one that says the channel
actually works: a question enqueued and never sent reached nobody.

## Tests

`controlIntent`, `controlQuestion`, `controlActions`, `controlReplyHandler`,
`controlButtons`,
`controlAskPass`, `controlHandlerRegistration`, `controlNoCodeAccess`,
`controlFingerprint`, `controlAiIntent`, `controlDailyDigest`, `controlDigestPg`
(requires `TEST_DATABASE_URL`), `controlChannelPg` and
`controlKnowledgePg` (both require `TEST_DATABASE_URL`), plus the question and
threaded-reply cases in `notificationSend` and the `control.remembered` cases in
`healthOperationsBlock`, plus `engineeringRequestsPg` and `decisionHoldsPg`
(both require `TEST_DATABASE_URL`).
