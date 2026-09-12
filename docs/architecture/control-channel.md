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

### 5. No model is in the reply path

B1 is deterministic end to end. `parseIntent` is pure, has no parameter through
which a model could arrive, and a test asserts its signature. B2 adds an AI
fallback and **only** for a reply the deterministic parser returned `unclear`
for; until then there is none, and `tests/controlNoCodeAccess.test.js` fails if
one appears.

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
| 7 | meaning | `parseIntent` — unclear asks again rather than guessing |
| 8 | do it | `executeOffered`, the only writer |

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
- `max_questions_per_pass` (default 5), oldest finding first;
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

## Attribution

`initiatorFor` in `services/operations/corrections/apply.js` learned a third
form: `telegram:<id>`, between `admin:<id>` and the `system` fallback.

This is not cosmetic. The schema's
`operational_corrections_system_is_auto_only` CHECK refuses an approval-tier
correction whose initiator is `system`, so without the branch an owner's "yes"
would fall through to `system` and be refused — the owner would have answered a
question Wenze then could not act on. `tests/controlChannelPg.test.js` drives
both halves against the real constraint.

## What B1 deliberately does NOT do

- **remember** an answer, so the same condition re-asks after the window (B2);
- read an unclear reply with a model (B2);
- record an `engineering_requests` row — B1 acknowledges the intent and says
  plainly that nothing changed (B3);
- auto-apply a remembered `approve`. That would be autopilot through a side
  door, and it stays refused in B2 as well.

## Reading it from outside

`/api/health` → `operations.control`, counts only — no chat id, no operator id,
no text:

```
enabled     is the channel switched on
operators   HOW MANY may be obeyed. Switched on with an empty allow-list is a
            channel that obeys nobody, and it looks identical to a working one
            from everywhere else on this endpoint.
questions   asked · delivered · answered · outstanding · lastAskedAt
total/refused/last7d/lastAt   the replies
```

**`questions` and the replies answer different questions, and the first was
missing.** Zero replies reads exactly the same whether five questions went out
and nobody answered, or none were ever sent — and those need opposite responses
from whoever is reading this. `delivered` is the one that says the channel
actually works: a question enqueued and never sent reached nobody.

## Tests

`controlIntent`, `controlQuestion`, `controlActions`, `controlReplyHandler`,
`controlAskPass`, `controlHandlerRegistration`, `controlNoCodeAccess`,
`controlChannelPg` (requires `TEST_DATABASE_URL`), plus the question and
threaded-reply cases in `notificationSend`.
