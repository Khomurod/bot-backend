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
   structurally rather than by promise. A code-level request becomes a recorded
   note for a person. There is also **no model anywhere in the reply path** as
   of B1 — reading a reply is a pure, ordered rule set in `lib/control/intent.js`
   whose signature has no parameter through which one could arrive.
5. **Every responsibility can be switched off**, per capability, in
   Settings → AI → AI Responsibilities. The switch is honoured in
   `services/ai/router.js`: a refused capability raises the same error as a
   provider outage, which is the path every consumer already falls back through.

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
| **Fuel station** from a message — `fuel_stop_detection` | Creates a fuel watch, messages the driver | Regex fallback; no address means no watch | **Remains automatic.** A wrong watch costs one reminder |
| **Pinned load details** — `dispatch_load_extraction` | Cached load context behind driver ETA messages | Deterministic destination inference beneath it; with too little, the driver is told there is no current load info rather than a wrong one | **Remains automatic** |
| **Chat message labels** — `chat_annotation` | `chat_message_annotations` | None needed — gap-filling was removed, so an unlabelled message stays unlabelled instead of being invented | **Remains automatic** |
| **Provider terms interpretation** — `policy_reading` | An AI policy finding | A provider is suspended only by an enumerated deterministic rule that never sees the model's output | **Remains automatic for the words; the suspension stays deterministic** |
| **A moved terms page** — `policy_source_discovery` | The watched URL | Every candidate is fetched and verified first; AI only re-ranks among verified ones, and its answer must be one of them | **Remains automatic** |
| **Answering a candidate out of hours** (`recruiting_after_hours_reply`) | Sends an SMS in the assigned recruiter's name; writes the mirror row and the conversation counter | It may state ONLY figures already in a confirmed `recruiting_knowledge` statement — anything else refuses the whole reply, not the figure. It cannot promise, guarantee, approve, waive, hire or set a date. Capped at four replies, silent in quiet hours, and stood down the moment a person answers | **Automatic, and the only place AI speaks with no deterministic answer beneath it.** The protection is the two gates rather than a fallback, because there is no fixed sentence that answers "does the truck have an APU". When either gate refuses, one fixed acknowledgement goes instead |
| **Wording a retention notice** (`retention_summary`) | Nothing — the notice body only | Refused twice if it reaches for an employment decision: as the router's validator, so a straying provider loses its turn, and again on the finished body. Given counts and reason phrases only — no name, no message text | **Wording only.** Which drivers are flagged, and why, is arithmetic in `lib/retention/signals.js` with no model in it |

## Text only — no record changes

Safety coaching notes to a driver (the fixed sentence is a good sentence, and a
model reaching for a consequence is refused), the one-line summary on a
self-healing or learning notice, home-time replies to drivers, the fuel reminder
wording, insight-card narration
(the card and its severity stand without it), drafted reports (a person edits and
sends), broadcast translation (a person sends), birthday and banter messages.
Each has a fixed sentence to fall back on, except reports and translation, which
simply become unavailable.

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
