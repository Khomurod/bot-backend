# Reading a finance message, and the life of a money code

How the Finance Monitor turns what the finance group typed into an auditable
record — and everything it deliberately refuses to conclude.

Split out of [`finance-monitor.md`](finance-monitor.md), which owns the feature
as a whole: the capture gate, the settings, the documents queue, the weekly
report and where payment text is allowed to live. This file owns the reading.

## 4e. Reading a real message: labels, not a number scanner

Version 1 of the parser had never seen a message from the company. Version 2 was
written against the format production actually sends:

```
Money Transfer code: 1491583146
Report Reference: 165373918
Amount: 480.00
Issued to: WENZE INVESTMENTS LLC
Notes: B-1 911 BRHANE GEBRU
```

Version 1 answered **`not_moneycode`** — "money transfer code" was not in its
keyword list. That is three faults in one message, and only the first is a
keyword:

1. the phrase was unknown, so the message was not finance at all;
2. `Report Reference` is a second long number, so **adding the phrase would have
   made it `ambiguous`** — "2 candidate codes", one of which was never a code;
3. `Amount: 480.00` carries no `$`, so the amount was invisible.

**So the parser reads LABELS.** The word in front of a number is what tells a
person which number it is, and it is now what tells the parser. A line labelled
as a reference is never a candidate code, which is the whole of fault 2.

### Fuzzy on the label, exact on the value

`lib/finance/moneycode/labels.js` matches a label by bounded edit distance, so
"Money Trasfer Code", "Money Transfer cod", "money transfercode", a missing
colon and any casing all mean the same field. **Tolerance stops at the label.**
Every digit comes back verbatim through `values.js`; the only transformation is
dropping the spaces and dashes somebody used to group a code, which changes no
digit. A parser that could repair `148158314` into a ten-digit code would be
inventing money.

The tolerance is proportional and short labels get none: `efs` and `ref` are
three characters, so one edit reaches a great many words that are not labels.
Under five characters must match exactly — `eft` is not `efs`.

**A format it cannot read is preserved, not discarded.** `unparsed` and
`ambiguous` keep the message and say why, and the version stamp means a later
parser can come back to exactly those rows.

## 4f. A money code has a life

`active` · `voided` · `replaced` · `needs_review` · `duplicate_posting`.

**Nothing is ever deleted.** A void adds a state, a time, the message that
caused it and the evidence for the link. The digits, the amount, the original
message and the issue time stay exactly as they were, and
`finance_moneycode_events` records every transition — including whether a model
contributed to it.

### A request to void is not a void

These arrive minutes apart in a real finance chat and mean opposite things:

| what somebody typed | what it is |
|---|---|
| "need to void this one?" | a question — nothing has happened |
| "please void 1491583146" | a request — nothing has happened yet |
| "working on it" | still nothing |
| "voided" / "done, voided" | now something has happened |

`lib/finance/void/intent.js` orders its rules so that **anything which is not
plainly a completed action is not one**. A question, a request or a negation
each beat "completed", whatever else the sentence contains.

### Which code, and when not to say

`lib/finance/void/target.js`, strongest evidence first:

1. the message **names** a code we hold;
2. the message **replies** to the one that issued a code;
3. exactly **one** active code is in scope and nothing contradicts it.

**Two hard signals disagreeing is the most dangerous case in the feature** — a
message naming one code while replying to another — and it always goes to a
person. So does a bare "voided" with two candidates, and a code we have no
record of. Marking the wrong code dead is not a smaller mistake than marking
none; it is worse, because it looks like an answer.

The asymmetry is deliberate: an unvoided void leaves a total slightly high and a
person able to see why; a wrong void makes real money vanish.

### A message doing two things is not read as one

"Voided — replacement below:" followed by a labelled code is a real shape, and
reading it as only a void threw the new code away **in silence**: the status was
settled, so nothing flagged it, and the money in it would never have appeared on
any screen or in any total. Such a message is `needs_review`, with the void
reading and both codes carried along, and a person settles it.

The distinction is the **label**. A code merely named in the prose of a void —
"voided 1491583146" — is the void's subject, not an issue, and is read as a void
exactly as before.

### One code replacing another needs MORE evidence than a void

`lib/finance/replacement.js`. A replacement is recorded only when a message
**says so** — "replacement for", "re-issued as", "supersedes" — and only when
the same message carries hard evidence of which code it means: it names the old
code's digits, or it replies to the message that issued it.

**There is deliberately no "the only code in scope" rung here**, which the void
ladder does have. A finance group issues codes to several drivers in the same
few minutes, so "a code was voided and another appeared" is evidence of a busy
afternoon, not of a relationship. Chaining them would invent a link nobody
stated and then report it as history. A void talks about money already spent; a
replacement asserts that two payments are one story, and getting that wrong
merges two drivers' money.

When the language is there and the target is not, the **message** is marked
`needs_review` and the new code is recorded in full. The money is real either
way — only the relationship is in doubt.

The grammar half of "did this happen, or is somebody asking for it" is one
module, `lib/finance/phrasing.js`, shared by void and replacement detection.
Keeping two copies would have let "please void" and "please replace" drift into
being read differently.

## 4g. AI reads meaning; it never reads numbers

The deterministic parser is the path. A model is asked only about messages the
rules could not settle (`unparsed` or `ambiguous`), and only for a **kind** —
issuing, voiding, requesting, or ordinary conversation.

**Every number it returns is looked for in the captured text**
(`lib/finance/aiReading.js`) and dropped if it is not there. A substring of a
real code is refused too: `4915831` sits inside `1491583146` and is a different
number. A reading that claims a code the message does not contain is refused
whole.

It never decides which code a void refers to — that stays with the rules above.
**With no provider at all the Finance Monitor behaves exactly as it does with
one**, minus the fallback: `AiUnavailableError`, a cooldown, a switched-off
capability all mean "the rules stand".

### And it may never void or replace

A verified reading can move a message off the unclear pile and can mark a code
as wanting a person. **It can never call `voidCode` or `markReplaced`.** Those
are automatic actions against money, and the standing rule is that AI interprets
evidence and does not manufacture the evidence an automatic action needs. So an
AI-read void becomes `needs_review` on the code it names, with the reading
stored and `decided_by = 'ai'` on the event, and a person finishes it.

The offer happens in the background pass (§4h), never in the Telegram capture
path — a model call there would hold that pipeline open on every finance
message. Each message is offered **once**: `ai_read_at` is stamped only when
something actually answered, so a provider on cooldown does not spend a
message's single chance.

## 4h. Re-reading what an older parser misunderstood

A version bump creates a backlog: rows captured while version 1 ran, holding
real money, that nothing would ever look at again. `finance_reparse` rides the
scheduler's tick — which fires **at boot** and then hourly — and re-reads them
oldest first, 25 at a time, through the same path the Re-read button uses.

It is safe to run repeatedly: `ON CONFLICT (message_ref_id, code_normalized) DO
NOTHING` means a second pass records no second code, and a re-read never
resurrects a code somebody voided (§4f).

**A re-read acts on what it newly understands, not only on what it re-labels.**
Version 1 had never heard of "void" either, so every void in the captured table
reads `not_moneycode` today. A pass that changed the status and stopped there
would leave codes the group itself declared dead sitting in the active total —
the same silence, one step further along. So a re-read that reaches
`void_action` resolves it through the same `voidService` a live message uses,
and one that reaches `parsed` goes through replacement detection as well. The
stored `chat_id`, `reply_to_message_id` and text come back from the re-read for
exactly that reason.

## 4i. Reading the history back

`GET /api/finance/moneycodes/:id/events` and the **History** expander on the
Money codes tab. The row says what is true; the events say how it got there —
which message did it, whether a rule or a model read that message, and how sure
it was. A state with no trail behind it is an assertion a person has to take on
faith, and "why is this voided" asked six weeks later is the question the table
exists to answer. Read-only: no route writes an event by hand.
