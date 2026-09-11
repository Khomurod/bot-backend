# After-hours recruiting: what Wenze may say to a candidate, and when

**Read this before changing anything under `lib/recruiting/`,
`services/recruiting/`, or the SMS mirror.** Every rule below is either a
safety boundary the owner asked for in as many words, or a defect that was
found while building it.

Related: [`recruiter-sms-sender.md`](recruiter-sms-sender.md) (which number
texts a lead), [`recruiting-knowledge.md`](recruiting-knowledge.md) (how Wenze
is taught), [`operational-notifications.md`](operational-notifications.md)
(where a handoff notice goes).

---

## The problem

A Facebook lead is texted within seconds of arriving, from the assigned
recruiter's own number. A lead that arrives at 9pm on a Friday is answered by
the candidate within minutes — and then hears nothing until Monday, by which
time the good ones have taken a job that answered.

Nothing was broken. There was simply nobody there.

## What changed

Outside configured working hours, Wenze continues the SMS conversation in the
assigned recruiter's name. **The existing pipeline is untouched**: Facebook lead
→ Bitrix assignment → that recruiter's RingCentral number. Wenze sends through
the same `sendSmsAsRecruiter`, from the same number, and the candidate sees one
continuous conversation.

## The safety shape, and why it is different from everything else here

Everywhere else in this repository, AI wording sits on top of a decision
arithmetic has already made, and a fixed deterministic sentence is what ships
when anything goes wrong. The safety coach is the model: `lib/safety/patterns.js`
decides *whether* a driver is coached with no model in it at all.

**A conversation has no deterministic answer.** There is no fixed sentence that
responds to "does the truck have an APU". So the protection could not be a
better fallback. It is a gate on both ends:

| | |
|---|---|
| **Before** | The model may only speak from `recruiting_knowledge` — statements an administrator typed and then *confirmed*. With none approved, Wenze does not answer at all, because it has nothing it is allowed to say. |
| **After** | `lib/recruiting/replyGuard.js` refuses the whole reply if it contains a figure no approved statement contains, or if it grants, guarantees, hires, or sets a date. |

And when either end refuses, the candidate is **not** left in silence: one fixed
acknowledgement goes out saying a recruiter will follow up. True, commits
nothing, better than Monday. Once per conversation — somebody told twice that a
person will be in touch has learned that nobody is.

### The number rule is the enforcement

"AI must never invent or promise conditions outside approved company
information" is a sentence, and a sentence is not enforcement. The enforceable
form rests on an observation: **an invented condition is almost always a
number.** A rate, a mileage, a sign-on bonus, a home-time interval, an age
limit, a start date. Prose can be vague and harmless; "77 cents per mile"
cannot.

So every number in a draft must already appear in something a human approved.
One that is not → **the reply is refused whole.** Not edited. A sentence with
its rate silently removed is a worse answer than no answer, and repairing a
model's claim is how a wrong one survives review.

**The conversation is deliberately not an approved source.** A candidate who
writes "I heard you pay 80 cpm" has put 80 into the thread, and a guard that
accepted numbers from context would let Wenze agree with it. The candidate is
not an authority on the company's own terms. A figure the *system* supplied —
the day the office reopens — is passed to the guard explicitly as
`extraApproved`, because it did not come from the model.

### What a reply may never do

`FORBIDDEN` in `replyGuard.js`, each entry a commitment a candidate could hold
the company to: guarantee anything, promise anything, approve/waive/make an
exception, say somebody is hired or accepted, offer a job or a truck, set a
start date, waive a hiring requirement.

**"Exception" as a word is deliberately still usable.** The approved answer to a
candidate asking for one is that the recruiter can discuss it during working
hours, and a blanket ban would have refused the correct reply. What is refused
is *granting* one.

## The gates, in order

Each returns a **named reason**, asserted in `tests/recruitingAfterHours.test.js`.
"Why did Wenze not answer this candidate" is a question somebody will ask, and
`false` is not an answer to it.

| Gate | Stands down when |
|---|---|
| `disabled` | `ai_after_hours_enabled` is off. Default, and a migration never turns it on. |
| `within_working_hours` / `no_hours_configured` | The office is open. **No configured hours means always open**, so an unfilled form can never switch the feature on. |
| `quiet_hours` | Shut *and* asleep. 21:00–08:00 by default: the office being closed is what makes this feature's turn; 3am is what makes a text from it rude. |
| `capability_off` | The `recruiting_after_hours_reply` responsibility switch. |
| `conversation_handed_off` / `conversation_stopped` | A person took it back, or a guard already stopped it. |
| `recruiter_took_over` | A recruiter replied *after* Wenze did, read from the transcript. |
| `no_recruiter_can_send` | Nothing goes out in a name that cannot send. |
| `reply_cap` | Four replies by default. The candidate still gets the acknowledgement, and a human is told. |
| `no_approved_knowledge` | **Nothing approved means nothing to say.** |
| `refused_by_guard` | The draft named an unapproved figure, or committed something. |
| `ai_unavailable` / `ai_bad_shape` | No provider, or an answer that is not an answer. |

## Working hours are NOT the auto-message rules

`facebook_lead_auto_message_rules` already carries days and times, and reusing
it was the obvious move. It is the wrong table: those windows pick **which
opening template** a new lead is sent, and a lead outside them still gets a
text. Binding "may Wenze speak for a recruiter" to the same rows would mean an
administrator editing a greeting silently changed who is allowed to answer a
candidate.

### An overnight window belongs to the day it starts

`22:00–06:00` on Friday covers Friday night and the small hours of Saturday.
The obvious implementation — check the time span, then check today's weekday —
gets the span right and the day wrong: it reports Saturday 02:00 as open on a
*Saturday-only* window that has not begun. `pickActiveRule` in
`facebookLeadAutoMessageService.js` has that bug today; there it picks a message
template, so the cost is a slightly wrong greeting. Here the cost would be
silence when a candidate was owed an answer, so `windowCovers` resolves the tail
of a window against the **previous** day. Two tests assert it, and both fail
against the naive version.

## The thread, and the half of it that was missing

The conversation is assembled from `facebook_lead_sms_mirrors`, the ledger every
SMS already passes through, rather than from a second store that could disagree
with it. Four kinds of row:

| `source_type` | |
|---|---|
| `inbound_rc` | the candidate wrote |
| `outbound_auto` | the opening template went out |
| `outbound_recruiter` | **new** — a recruiter typed a reply in Telegram |
| `outbound_ai` | **new** — Wenze answered after hours |

`outbound_recruiter` closes a hole that predates this feature: a reply typed in
Telegram was **sent and never recorded**, so the database held the company's
opening line and the candidate's answers and nothing in between. Anybody reading
that thread back — a person or a model — was reading half a conversation and
could not tell. It is now written by `services/facebookLeads/smsReplyRelay.js`.

`MIRROR_SOURCES` lives in `lib/recruiting/thread.js` and the mirror service takes
its insert allow-list **from** it, so a kind cannot be insertable in one place
and invisible in the other. A test asserts that.

**Wenze's own turns are labelled as Wenze**, not merged into the recruiter's.
The candidate cannot tell them apart — that is the point — but the model must
("I already said this" and "a person already said this" carry different weight),
and a human reading the transcript after a complaint needs to know which is
which. Every reply is also posted into the recruiter's Telegram thread, marked
`🤖 Wenze answered after hours`, so they read what went out in their name before
answering on top of it.

## What it will never do

**No employment decision, ever.** Not hire, not reject, not promise a truck, not
set a start date, not grant an exception. `replyGuard` refuses each in as many
words, and `tests/recruitingAfterHours.test.js` asserts that even the *handoff
notice* never asks a human for one either.

## Tests

```
node --test tests/recruitingWorkingHours.test.js    # 15 — the schedule, incl. overnight
node --test tests/recruitingReplyGuard.test.js      # 21 — what a reply may never say
node --test tests/recruitingThread.test.js          # 12 — the transcript
node --test tests/recruitingAfterHours.test.js      # 23 — every gate, by name
node --test tests/recruitingHoursRoutes.test.js     # 11 — what the screen refuses
TEST_DATABASE_URL=... node --test tests/recruitingAfterHoursPg.test.js   # 12
npm test --prefix admin -- --run WorkingHoursCard   # 9
```

Confirmed failing-first against the code they guard: the two overnight-window
tests (naive span-then-weekday), eight guard tests (enforcement removed), and
three orchestrator tests (the knowledge gate and the guard call removed).
