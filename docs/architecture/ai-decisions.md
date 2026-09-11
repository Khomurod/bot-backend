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
   `operational_corrections.initiator` is `system` or `admin:<id>`, never a
   model. AI ranks and explains; deterministic evidence and people decide.
2. **Ambiguity means no change.** Every classifier has a third answer besides
   yes and no, and it is not a synonym for either.
3. **A manual decision by an administrator is never overwritten.**
4. **Every responsibility can be switched off**, per capability, in
   Settings → AI → AI Responsibilities. The switch is honoured in
   `services/ai/router.js`: a refused capability raises the same error as a
   provider outage, which is the path every consumer already falls back through.

## Decisions that can change stored information

| What AI decides | Writes | Guard | Verdict |
|---|---|---|---|
| **Driver Active / Inactive** from a chat title (`groupStatusAiClassifier`, twice daily) | `groups.active`, `status_source='ai'` | Manual status excluded from the query. Ambiguity leaves it unchanged. **A deactivation is refused outright when the records show the driver working** — a recent message in the chat, home-time tracking having seen them, an open cycle, a recent road leg, a truck assigned (`lib/drivers/deactivationGuard.js`) | **Remains automatic, with stronger evidence.** Turning a driver back ON stays unguarded: that is the safe direction, and it is what an operator wants after a title is fixed |
| **Driver profile fields** from a title (`driverProfileAiParser`) | `driver_profiles` names, unit, type | A deterministic parse is the baseline and AI merges over it; manually set fields are protected; low-confidence rows are flagged `needs_review` | **Remains automatic.** The values are re-derivable and visible on the Driver Groups page |
| **Home-time intent** (`homeTimeIntentService`) | Opens `home_time_requests`; can move a driver Home ↔ Road | Confidence floor of 85 for a state change plus sender, first-person and operational-context gates; a precision guard overrules a confident model on errand and trip-progress wording; the deterministic fallback only acts on unambiguous time-off phrasing | **Remains automatic.** The guards, not the model, decide the hard cases |
| **Home-time dates** from a reply | Dates on an open request | Normalised and policy-checked server-side; an unreasonable window is re-asked, never stored | **Remains automatic** |
| **Home-time screenshot import** | Home-time records in bulk | Operator-initiated, reviewed on screen before applying | **Remains automatic**, because a person is already looking at it |
| **Returned to Road** (`returnReasoning`) | Nothing directly | Consulted only on an already-ambiguous case; may raise it to confident **only when the coordinates already proved movement**, and may always stand one down | **Suggestion only, by construction.** The state change is a governed correction, capped and revertible |
| **Fuel station** from a message | Creates a fuel watch, messages the driver | Regex fallback; no address means no watch | **Remains automatic.** A wrong watch costs one reminder |
| **Pinned load details** | Cached load context behind driver ETA messages | Deterministic destination inference beneath it; with too little, the driver is told there is no current load info rather than a wrong one | **Remains automatic** |
| **Chat message labels** | `chat_message_annotations` | None needed — gap-filling was removed, so an unlabelled message stays unlabelled instead of being invented | **Remains automatic** |
| **Provider terms interpretation** | An AI policy finding | A provider is suspended only by an enumerated deterministic rule that never sees the model's output | **Remains automatic for the words; the suspension stays deterministic** |
| **A moved terms page** | The watched URL | Every candidate is fetched and verified first; AI only re-ranks among verified ones, and its answer must be one of them | **Remains automatic** |

## Text only — no record changes

Home-time replies to drivers, the fuel reminder wording, insight-card narration
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
