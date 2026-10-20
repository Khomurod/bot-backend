# Hiring stage proposals — Bitrix deal stages, proposed in the recruiting group

**Read this before touching** `lib/hiringStages/*`, `services/hiringStages/*`,
`services/bitrix24DealStages.js`, `database/hiringStages/*`,
`bot/handlers/hiringStageHandlers.js` or
`admin/src/pages/settings/HiringStagesCard.jsx`.

## What it does

In the recruiting group's **General** topic, Safety and the recruiters talk
each candidate through, by replying to the recruiter's post: "CLH sent" →
"Done" → "CLEAN" → "Approved" → "drug test all set". The recruiting team works
the same candidates as **deals** in a Bitrix pipeline (New → CLEARINGHOUSE
CHECK → MVR + PSP CHECK → READY → …).

The owner asked on 20 October 2026 for the bot to follow that conversation
and, when it shows a candidate has moved on, **propose — with a button —
moving that candidate's deal** to the right stage. Their answers to the
questions asked before building it:

| Question | Answer |
|---|---|
| Where is the proposal posted? | As a **reply in General**, under the message that moved the conversation |
| Who may confirm? | **Anyone in the group** |
| Which stages may be proposed? | **Any stage of the pipeline** — the model picks, by meaning |
| How is the deal found? | **By phone and name.** With none found, the bot asks the recruiter who posted the candidate (the one who sent the CDL) to create it |

## The rules, and why each one exists

A wrong move puts a candidate in the wrong place in the recruiting pipeline —
skipped checks, or lost from a recruiter's queue. Every rule below closes a way
to make one.

1. **A model proposes; a person moves the deal.** `crm.deal.update` is called
   from exactly one place (`services/hiringStages/actions.js`), after somebody
   in the group pressed **Move**. There is no automatic mode.
2. **The deal is read again at the press.** If somebody moved it by hand since
   the proposal, it is not moved (`stale`, and the message says where it is
   now). If it is already there, nothing is written.
3. **A press is answered once.** It claims the row (`pending → applying`) in
   one UPDATE; a second press is told "Already answered". Bitrix failing gives
   the claim back, so the button still works later. Only a press in the
   configured group, by a person (not a bot), counts.
4. **Forward only — or out.** `lib/hiringStages/proposal.js` keeps a stage only
   if it is one of the deal's own pipeline's stages, not where the deal is,
   and later in the pipeline than it — or a failure (lost) stage, which may end
   a candidate from anywhere. A closed deal (won or lost) is never reopened by
   a proposal. "Can we check it once again" is not a reason to send a deal
   back; a person can always do that in Bitrix.
5. **The evidence is somebody's words.** The model must quote the message that
   shows the stage, and the quote must be in the conversation (as written, or
   as the model saw it). The proposal shows that quote, not a summary.
6. **The name is the conversation's.** Every part of the driver's name the
   model gives must be a whole word in the conversation.
7. **The phone is the strong key; a name is a weak one.** The deal is found by
   a phone a recruiter typed (`crm.duplicate.findbycomm` → that contact's open
   deals, newest change first). Only with no phone match is the name tried: a
   contact matches only with its first AND last name among the posted words (in
   any order — posts read "PHILLIPS SAMUEL JAHBARI"), a deal title only with two
   of them. **Two different people matching proposes nothing** (`ambiguous`).
   Only open deals are looked at.
8. **Only a candidate post is read.** General also carries "the driver is
   there" and "office is closed". A conversation is read only when its post has
   a picture (the CDL) or a phone number — anything else costs no model call
   and posts nothing.
9. **Nothing identifying leaves for the model.** `lib/hiringStages/redact.js`
   takes out SSNs (labelled, dashed or bare), labelled birth dates and licence
   numbers, every phone number and every other run of seven or more digits
   before the text is put in a prompt. No photo is sent.
10. **One open proposal per conversation, and no repeats.** A newer stage
    supersedes the open proposal (its message is edited, its buttons go) — an
    earlier stage never does. A stage already proposed for that deal — open, moved or declined — is never
    proposed again. The recruiter is asked to create a deal once per
    conversation, and **Skip** means never.
11. **Off by default.** `safety_approval_settings.stage_proposals_enabled` is
    FALSE, and the feature also needs Safety Approvals on — it reads the
    messages Safety Approvals captures.

## How it flows

```
captured General message (services/safetyApprovals/captureService.js)
  → services/hiringStages/conversationQueue.js  (switch on? General? a reply? → follow replies to the post → enqueue)
  → services/hiringStages/worker.js             (queue wake scheduler; withRunRecord('hiring_stage_proposals'))
  → services/hiringStages/reviewer.js
       conversation (database/hiringStages/threads.js: the post, its album, every reply at any depth)
       → candidate post? → deal by phone (dealFinder.js) → the pipeline's stages (crm.status.list)
       → model (aiReading.js, capability `hiring_stage_reading`, redacted words only)
       → verifyStageAnswer → deal by name (if none yet) → stagePlan.js (carry the stage to the deal's pipeline by NAME)
       → "move X to STAGE?" [Move] [No]      replying to the newest message
         or "no deal — <recruiter>, please create it" [Deal created — search again] [Skip]   replying to the post
  → button press: bot/handlers/hiringStageHandlers.js (thin) → services/hiringStages/actions.js
```

- **A conversation is named by its post** — the message the reply chain leads
  back to; an album by its first item, so replies to the CDL's front and back
  are one conversation. A chain that leads to a message the bot never saw is
  not queued.
- **A burst is read once.** Every new message re-arms a 90-second settle delay
  and bumps the row's `revision`; a worker finishes only the revision it
  claimed.
- **Failures retry, then stop.** A model or Bitrix outage, or Telegram refusing
  the post, retries at 1, 5, 15, 30 and 60 minutes; after six attempts the row
  is `gave_up` until the next message in the conversation. A Bitrix answer
  that will not change by asking again (no access, Bitrix switched off) ends
  the read.
- **"Search again"** looks the candidate up again; a deal found turns the same
  message into a Move / No proposal, its stage carried to the deal's pipeline
  by name.

## Data

Migration `0076_hiring_stage_proposals.sql`:

| Table / column | What it holds |
|---|---|
| `safety_approval_settings.stage_proposals_enabled` | the switch (Settings → Safety Approvals → 5) |
| `hiring_stage_threads` | one row per conversation: the queue, and what the last read concluded (never the raw model answer) |
| `hiring_stage_proposals` | what the bot posted and what became of it — who pressed, when, from which stage to which |

Proposals carry a driver's name and phone, so closed ones are **deleted after
60 days**, like the captured messages; finished queue rows too. Nothing logs
message text or a phone number.

## Bitrix

`services/bitrix24DealStages.js` uses the same inbound webhook as the lead
push (Settings → RingCentral → Bitrix24, which must be **enabled**). The
webhook needs the `crm` scope with write access. Calls: `crm.duplicate.findbycomm`,
`crm.contact.list`, `crm.deal.list`, `crm.deal.get`, `crm.status.list`, and
the one write, `crm.deal.update`. Each is bounded at 15 seconds. With no deal
found, the stages shown to the model are those of the pipeline set as the
deal category in Bitrix settings, or the default pipeline.

## Tests

`tests/hiringStageRules.test.js` (redaction, the transcript, verification, the
messages), `tests/bitrix24DealStages.test.js` (the Bitrix calls and the deal
finder), `tests/hiringStageFlow.test.js` (read → propose → press → move),
`tests/hiringStageQueue.test.js`, `tests/hiringStageStorePg.test.js` and
`admin/src/pages/settings/SafetyApprovalsTab.test.jsx`.
