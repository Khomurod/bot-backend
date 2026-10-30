# Where AI can change what Wenze knows — the inventory, and the verdict on each

> Read this before adding an AI call that writes anything, and before changing
> one that already does. The catalogue that backs the admin screen is
> `lib/ai/capabilityCatalog.js`; this document is the review behind it.

Every place a model's answer reaches stored operational state, what it decides,
what stops it being wrong, and the decision taken about each. "Text only" means
the model writes words a person or a driver reads — no record changes — and is
listed separately at the end because it needs far less care.

## The rules that apply to all of them

1. **A model may never author or apply an operational correction.**
   `ai_capabilities.may_auto_apply` is `CHECK`ed to FALSE in the schema, and
   `operational_corrections.initiator` is `system`, `admin:<id>` or
   `telegram:<id>` — a person answering in the notifications group — never a
   model. AI ranks and explains; deterministic evidence and people decide.
2. **Ambiguity means no change.** Every classifier has a third answer besides
   yes and no, and it is not a synonym for either.
3. **A manual decision by an administrator is never overwritten.**
4. **A model may never change Wenze's own source code.** The control channel
   lets an owner steer Wenze from Telegram; it cannot reach the filesystem, a
   process or git, and `tests/controlNoCodeAccess.test.js` asserts that
   structurally rather than by promise. A code-level request becomes a row in
   `engineering_requests` for a person, and **no column in that table can hold
   code or a file path** — not `patch`, not `diff`, not `file`, not `branch`:
   the same test reads the migration and fails if one appears. A schema with
   nowhere to put a patch cannot be talked into applying one.
   The deterministic reader also runs FIRST, always: `lib/control/intent.js` is
   pure and has no parameter through which a model could arrive, and
   `control_reply_reading` is reached only on `unclear`.
5. **Nothing may propose that Wenze be trusted with more.** The learning
   registry holds exactly one action and it only ever switches automation OFF;
   there is no `enable_auto_apply` and there will not be. A run of approvals —
   the case that most looks like an argument for autopilot — produces words with
   no button, because a machine proposing its own promotion is the shape nobody
   should build, however many confirmations sit in front of it.
   `tests/learningActions.test.js` asserts the registry's shape.
6. **Every responsibility can be switched off**, per capability, in
   Settings → AI → AI Responsibilities. The switch is honoured in
   `services/ai/router.js`: a refused capability raises the same error as a
   provider outage, which is the path every consumer already falls back through.
7. **An unsure answer is checked by a stronger model, and if it is still unsure
   it decides nothing** (the owner, 23 October 2026). For the decisions in
   `lib/ai/escalation.js`, a free model's answer under 85% confidence — or one
   that says "unclear", or gives no confidence — is asked again of Claude
   (Sonnet, then Haiku), then of another paid model if Claude is unreachable.
   An answer still unsure comes back marked `uncertain`. The readings that
   decide on their own — `control_reply_reading`, `safety_approval_reading`,
   `hiring_stage_reading`, `recruiting_knowledge_reading` — treat that exactly
   like rule 2's third answer. The home-time and driver-profile capabilities
   keep the gates they already had, listed in the table below (the request
   floor and its precision guard, the policy check on a window, the operator
   reviewing an import, `needs_review` on a profile, movement proof before a
   return to road); for them `uncertain` changes who answered, not what the
   answer may do. When the caller said what to ask, an answer still unsure
   also becomes a question for the owner in the notifications group, and the
   owner's plain-words answer is given to later prompts for that kind of
   decision ([ai-learning.md](ai-learning.md)) — a lesson, never a decision:
   it changes nothing that has already been decided. A higher confidence is never
   a licence to skip the deterministic checks below: they run on every answer,
   whichever model wrote it. See [`docs/brief/ai-gateway.md`](../brief/ai-gateway.md).

## Decisions that can change stored information

Each row names the capability key from `lib/ai/capabilityCatalog.js`, so the
switch an administrator sees in Settings → AI and the verdict recorded here are
the same thing under the same name. `tests/aiDecisionsDoc.test.js` fails when a
capability that can change stored state is missing from this table — a document
like this goes stale silently, and silently is exactly how it would stop being
true.

| What AI decides | Writes | Guard | Verdict |
|---|---|---|---|
| **Driver Active / Inactive** from a chat title — `driver_status_classification` (`groupStatusAiClassifier`, twice daily) | `groups.active`, `status_source='ai'` | Manual status excluded from the query. Ambiguity leaves it unchanged. **A deactivation is refused outright when the records show the driver working** — a recent message in the chat, home-time tracking having seen them, an open cycle, a recent road leg, a truck assigned (`lib/drivers/deactivationGuard.js`) | **Remains automatic, with stronger evidence.** Turning a driver back ON stays unguarded: that is the safe direction, and it is what an operator wants after a title is fixed |
| **Driver profile fields** from a title — `driver_profile_extraction` (`driverProfileAiParser`) | `driver_profiles` names, unit, type | A deterministic parse is the baseline and AI merges over it; manually set fields are protected; low-confidence rows are flagged `needs_review` | **Remains automatic.** The values are re-derivable and visible on the Driver Groups page |
| **Home-time intent** — `home_time_intent` (`homeTimeIntentService`) | Opens `home_time_requests`; can move a driver Home ↔ Road | Confidence floor of 85 for a state change plus sender, first-person and operational-context gates; a precision guard overrules a confident model on errand and trip-progress wording; the deterministic fallback only acts on unambiguous time-off phrasing | **Remains automatic.** The guards, not the model, decide the hard cases |
| **Home-time dates** from a reply — `home_time_dates` | Dates on an open request | Normalised and policy-checked server-side; an unreasonable window is re-asked, never stored | **Remains automatic** |
| **Home-time screenshot import** — `home_time_import` | Home-time records in bulk | Operator-initiated, reviewed on screen before applying | **Remains automatic**, because a person is already looking at it |
| **Returned to Road** — `home_time_return_to_road` (`returnReasoning`) | Nothing directly | Consulted only on an already-ambiguous case; may raise it to confident **only when the coordinates already proved movement**, and may always stand one down | **Suggestion only, by construction.** The state change is a governed correction, capped and revertible |
| **Chat message labels** — `chat_annotation` | `chat_message_annotations` | None needed — gap-filling was removed, so an unlabelled message stays unlabelled instead of being invented | **Remains automatic** |
| **Provider terms interpretation** — `policy_reading` | An AI policy finding | A provider is suspended only by an enumerated deterministic rule that never sees the model's output | **Remains automatic for the words; the suspension stays deterministic** |
| **A moved terms page** — `policy_source_discovery` | The watched URL | Every candidate is fetched and verified first; AI only re-ranks among verified ones, and its answer must be one of them | **Remains automatic** |
| **Answering a candidate out of hours** (`recruiting_after_hours_reply`) | Sends an SMS in the assigned recruiter's name; writes the mirror row and the conversation counter | It may state ONLY figures already in a confirmed `recruiting_knowledge` statement — anything else refuses the whole reply, not the figure. It cannot promise, guarantee, approve, waive, hire or set a date. Capped at four replies, silent in quiet hours, and stood down the moment a person answers | **Automatic, and the only place AI speaks with no deterministic answer beneath it.** The protection is the two gates rather than a fallback, because there is no fixed sentence that answers "does the truck have an APU". When either gate refuses, one fixed acknowledgement goes instead |
| **Reading an answer you typed in the chat** (`control_reply_reading`) | Whatever the finding's own answer writes — an applied correction, a dismissal, a delay | Reached ONLY after `lib/control/intent.js` returns `unclear`, so nearly every reply is decided with no model at all. It is shown the question as the owner saw it (which may name the driver and truck) as well as the reply. It may pick only from the keys that question already offered, checked as the router's validator and again on the finished object; it supplies no values, so nothing it returns can land in a driver's record. Unavailable, malformed or unoffered all mean `unclear` — the question stands | **Automatic for the reading, never for the permission.** An approval still goes through `applyCorrection` at approval tier with the operator as initiator, and a remembered approval is never re-applied |
| **Reading Safety's hire decision** (`safety_approval_reading`) | What is POSTED in the recruiting group's approvals topic: APPROVED or NOT APPROVED, by whom, under a driver's post | **Not used at all for a `#Approved` / `#NotApproved` hashtag** — the hashtag decides and the name is read off the post without a model (a model is asked only for the names of a post with none in writing, never for the decision). Only messages from the people named as Safety that carry a hashtag or the words "approved" / "not approved" / "hire" are read. Without a hashtag, `lib/safetyApprovals/reading.js` keeps a candidate only if every part of the name is in the post, Safety's words or Safety's file names (or the single candidate read off a CDL photo, marked as such); keeps a phone only if the recruiter typed it; drops an approval beside refusal words or a question; in a team counts only a driver Safety named; drops two different answers for one driver. For a decision not written as a reply, a model may only PICK one of the recent posts by label. Anything unsettled is asked of Safety in General, never guessed | **Interpretation, behind proof — and mostly not needed.** A hashtag needs no model; without one, a model reads the language but cannot post a name the messages lack, a phone the recruiter did not type, or an approval next to a refusal |
| **Which Bitrix stage a candidate has reached** (`hiring_stage_reading`) | A PROPOSAL posted in the recruiting group's General topic ("move <driver> to <stage>?") with Move / No buttons — the deal itself changes only when a person presses Move | `lib/hiringStages/proposal.js` keeps only a stage of the deal's own pipeline, forward of where the deal is (or a lost stage; a closed deal is never reopened), quoting words somebody actually wrote in that conversation, with a name whose every part is in it. The deal is found by the phone the recruiter typed, or by first AND last name — two different people matching proposes nothing. On the press the deal is re-read: a deal moved by hand meanwhile is not moved. SSNs, birth dates, licence numbers, phones and long numbers are removed before the model sees the text | **Proposal, behind a person.** A model reads the language and picks a stage name; it cannot move a deal, move one backwards, or name a driver the conversation lacks. With no provider, nothing is proposed and the conversation waits |
| **A second opinion on a load alarm** (`load_alarm_review`) | Nothing stored — it decides only whether the CHAT is told, and adds one sentence | Reached only for a disagreement the rules already found (`lib/loads/lifecycle.js`), once per load per day. Given statuses, distances, speeds and GPS age — no name, address or coordinate. Only `likely_bad_data` at confidence ≥ 80 holds the notice back; the finding is filed regardless, with the review in its evidence. Unavailable, switched off or malformed: the notice goes out unchanged | **Filtering and wording only.** Whether a load is in conflict, and its phase, are the rules' — a model can make the chat quieter, never a load's record different |
| **Wording a retention notice** (`retention_summary`) | Nothing — the notice body only | Refused twice if it reaches for an employment decision: as the router's validator, so a straying provider loses its turn, and again on the finished body. Given counts and reason phrases only — no name, no message text | **Wording only.** Which drivers are flagged, and why, is arithmetic in `lib/retention/signals.js` with no model in it |

Reading a gas station's address out of a fuel post (`fuel_stop_detection`),
which created a fuel watch and messaged the driver, went with fuel in October
2026 ([retired-fuel.md](retired-fuel.md)).

Reading the pinned load details out of a rate confirmation
(`dispatch_load_extraction`), which cached the load context behind the driver
ETA messages, went with the dispatcher ETA updates on 23 October 2026
([retired-dispatch-eta.md](retired-dispatch-eta.md)). Loads come from the
Dispatcher Board and Datatruck, with no model in between.

Reading a finance document (`finance_document_extraction`, which filled one
attachment's own record with what was printed on it) and saying what a finance
message MEANT (`finance_message_reading`, which could move a message off the
unclear pile but never author a digit or a void) went with the Finance Monitor
on 23 October 2026 ([retired-finance-monitor.md](retired-finance-monitor.md)).

## Text only — no record changes

Safety coaching notes to a driver (the fixed sentence is a good sentence, and a
model reaching for a consequence is refused), the one-line summary on a
self-healing or learning notice, home-time replies to drivers, the morning
summary's "most important today" (`daily_priorities` — it chooses among
problems the rules ranked and cannot add one), broadcast translation (a person
sends), birthday and banter messages. Each has a fixed sentence to fall back
on, except translation, which simply becomes unavailable. (Insight-card
narration and drafted reports went with AI Reports / Insights on 2026-10-30 —
[`retired-ai-reports.md`](retired-ai-reports.md).)

## What was deliberately NOT given to AI

- **Applying any operational correction.** See rule 1.
- **Deciding a driver returned to work.** Coordinates and load status decide;
  the model may only agree.
- **Suspending an AI provider.** An enumerated rule, with the quoted passage.
- **Filling a gap in an annotation.** A fabricated label is indistinguishable
  from a real one downstream, which is worse than none.
- **Deciding that a driver is a retention risk.** Arithmetic over facts other
  features recorded. A model only words one sentence about it, and every signal
  is something the COMPANY did or something the DRIVER said — never an
  assessment of the driver.
- **Any employment decision, anywhere.** Not hiring, not rejecting, not
  promising a truck, not setting a start date, not granting an exception, not
  recommending a replacement. Three separate guards refuse the language, in the
  recruiting reply, the safety coaching note and the retention notice.
- **Stating a figure nobody approved.** Every number in a reply to a candidate
  must already appear in a statement a person typed and confirmed. The
  conversation itself is deliberately not an approved source: a candidate who
  writes "I heard you pay 80 cpm" must not be able to have Wenze agree.
- **Changing one of its own rules.** The learning pass notices that Wenze has
  been corrected the same way three times and PROPOSES something. There is no
  status meaning "applied automatically" and no code path that reaches one: a
  suggestion may NAME a registered action, and naming is not doing. Only an
  administrator's POST to `/accept`, behind the apply gate, runs it.

  The registry that acceptance draws from holds exactly one action — turn a
  check's automatic correction OFF — and there is deliberately no action that
  turns anything ON. Nothing in it can touch pay, employment status, hiring,
  start dates, safety discipline, a driver's record, or application code.
  A suggestion that cannot be represented as a configurable rule records
  agreement and says, in the UI, that a person still has to carry it out — it
  never pretends to have been learned. See
  [`self-healing-and-learning.md`](self-healing-and-learning.md).
