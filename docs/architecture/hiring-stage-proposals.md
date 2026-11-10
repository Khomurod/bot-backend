# Hiring stage proposals — Bitrix deal stages, proposed in the recruiting group

**Read this before touching** `lib/hiringStages/*`, `services/hiringStages/*`,
`services/bitrix24DealStages.js`, `database/hiringStages/*`,
`bot/handlers/hiringStageHandlers.js` or
`admin/src/pages/settings/HiringStagesCard.jsx`.

**Since November 2026** (the owner, in one request): the conversation is still
READ in General, but everything the bot WRITES about Bitrix goes to a
**Bitrix topic** of its own; a candidate the conversation identifies for
certain who has **no open deal gets a contact and a deal created by the bot**
instead of a "please create it" request; and a recruiter's card with a line
like "Matthew's referral" is one driver, not a team
([`safety-approvals.md`](safety-approvals.md) rule 4a).

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
| Where is the proposal posted? | ~~As a reply in General~~ — **since November 2026 in the Bitrix topic** named in Settings, with the driver's name and a link to the post in General |
| Who may confirm? | **Anyone in the group** |
| Which stages may be proposed? | **Any stage of the pipeline** — the model picks, by meaning |
| How is the deal found? | **By phone and name.** With none found, ~~the recruiter is asked to create it~~ — **since November 2026 the bot creates the contact and deal itself** when the candidate is certain, and asks the recruiter (with the reason) only when not |

## The rules, and why each one exists

A wrong move puts a candidate in the wrong place in the recruiting pipeline —
skipped checks, or lost from a recruiter's queue. Every rule below closes a way
to make one.

1. **A model proposes; a person moves the deal.** `crm.deal.update` is called
   from exactly one place (`services/hiringStages/actions.js`), after somebody
   in the group pressed **Move**. There is no automatic mode. Creating a
   missing deal (rule 13) is not moving one: a created deal starts at the
   first stage, and the stage the conversation reached is still a proposal.
   No model decides a creation — the identity is read off the post by rules.
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
    messages Safety Approvals captures — and a saved **Bitrix topic**: the
    switch cannot be turned on without one, and while it is on without one
    (the state right after the November 2026 deploy) the worker is `blocked`
    and conversations wait in the queue. Nothing Bitrix is ever posted in
    General.
12. **Read in General, written in the Bitrix topic.** Every new message —
    proposal, "please create it", deal created, two people matching, Bitrix
    error — is sent with `message_thread_id` = `safety_approval_settings.
    bitrix_topic_id` and never as a reply (a reply cannot cross topics). Each
    names the driver and ends with a link to the post in General. Move / No
    results are edits of the proposal's own message. A notice is posted once
    per conversation (`hiring_stage_notices`, reserved before the send).
13. **A missing deal is created only for a CERTAIN candidate**
    (`lib/hiringStages/identity.js`): exactly one driver's name read off the
    post without a model (not a team, no name-shaped line in small letters),
    exactly one phone a recruiter typed, and — when the model named the driver
    — a name made of the post's words. Then, in Bitrix
    (`services/hiringStages/crmCreate.js`): the contact holding that phone is
    reused when its first and last name are among the post's words; two
    contacts holding it, another person's name on it, or this name on a
    contact under another phone **creates nothing** (`blocked`) — the recruiter
    is asked, with the reason. A new deal starts at the pipeline's **first
    open stage** (New Lead), titled with the name as posted, on the configured
    deal pipeline (default 0); the stage the conversation reached is then
    PROPOSED with Move / No like any other — creating never moves a deal. A
    recruiter's earlier **Skip** stops the bot creating it too.
14. **Never two records.** `hiring_stage_crm_records` claims the creation per
    conversation (and at most one in flight per phone — a second post of the
    same driver waits) and records each step BEFORE its Bitrix call:
    `claimed → creating_contact → creating_deal → created`. A call with no
    answer leaves the step in flight; the next read finishes it FIRST,
    searching by phone, by the contact's open deals and by the
    `ORIGINATOR_ID` / `ORIGIN_ID` the bot stamps on what it creates
    (`wenze_recruiting`, `tg:<chat>:<post>`) — and adds only when that finds
    nothing. A refusal (`failed`) or a block may be tried again on a later
    message; a conversation already `created` never creates again.

## How it flows

```
captured General message (services/safetyApprovals/captureService.js)
  → services/hiringStages/conversationQueue.js  (switch on? General? a reply? → follow replies to the post → enqueue)
  → services/hiringStages/worker.js             (queue wake scheduler; withRunRecord('hiring_stage_proposals'))
  → services/hiringStages/reviewer.js
       conversation (database/hiringStages/threads.js: the post, its album, every reply at any depth)
       → candidate post? → deal by phone (dealFinder.js) → the pipeline's stages (crm.status.list)
       → model (aiReading.js, capability `hiring_stage_reading`, redacted words only)
       (first: a creation an earlier read left in flight is finished — crmCreate.js resumeInFlight)
       → verifyStageAnswer → deal by name (if none yet) → no deal and certain? crmCreate.js (contact + deal)
       → stagePlan.js (carry the stage to the deal's pipeline by NAME)
       → propose.js, in the Bitrix topic (groupMessages.js), each with the driver and a link to the post:
         "created a deal for X" (once) · "move X to STAGE?" [Move] [No]
         or "no deal — <reason> — <recruiter>, please create it" [Deal created — search again] [Skip]
         or "N people in Bitrix match X" · "Bitrix error while handling X" (once)
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

Migrations `0076_hiring_stage_proposals.sql` and
`0100_hiring_stage_bitrix_topic_and_crm_records.sql`:

| Table / column | What it holds |
|---|---|
| `safety_approval_settings.stage_proposals_enabled` | the switch (Settings → Safety Approvals → 5) |
| `safety_approval_settings.bitrix_topic_id` | the Bitrix topic every Bitrix message goes to; cleared when the group changes; may not be the approvals topic |
| `hiring_stage_threads` | one row per conversation: the queue, and what the last read concluded (never the raw model answer) |
| `hiring_stage_proposals` | what the bot posted and what became of it — who pressed, when, from which stage to which; `note` is why a deal was not created automatically |
| `hiring_stage_crm_records` | the claim on creating a contact + deal: one per conversation, at most one in flight per phone, each step recorded before its Bitrix call |
| `hiring_stage_notices` | which notice ("created", "ambiguous", "bitrix_error:<revision>") was posted about a conversation |

Proposals, creation records and notices carry a driver's name and phone, so
closed ones are **deleted after 60 days**, like the captured messages;
finished queue rows too (a creation still in flight is kept). Nothing logs
message text or a phone number.

## Bitrix

`services/bitrix24DealStages.js` uses the same inbound webhook as the lead
push (Settings → Bitrix24, which must be **enabled**). The
webhook needs the `crm` scope with write access. Reads: `crm.duplicate.findbycomm`,
`crm.contact.list`, `crm.contact.get`, `crm.deal.list`, `crm.deal.get`,
`crm.status.list`. Writes: `crm.deal.update` (`STAGE_ID` only, after a press —
the only change to an existing record) and, since November 2026,
`crm.contact.add` and `crm.deal.add` — new records only, only from
`services/hiringStages/crmCreate.js`, each stamped `ORIGINATOR_ID =
wenze_recruiting`, `ORIGIN_ID = tg:<chat>:<post>`, a comment linking the post,
and `ASSIGNED_BY_ID` only when Settings → Bitrix24 names a numeric assignee
(otherwise Bitrix's own default and distribution rules apply — the bot does
not guess a recruiter's Bitrix user). Each call is bounded at 15 seconds.
With no deal found, the stages shown to the model — and the pipeline a new
deal is created in — are those of the pipeline set as the deal category in
Bitrix settings, or the default pipeline. A Bitrix error says only Bitrix's
own words; the webhook URL never appears.

## Tests

`tests/hiringStageRules.test.js` (redaction, the transcript, verification, the
messages), `tests/bitrix24DealStages.test.js` (the Bitrix calls — creation
fields and origin search included — and the deal finder),
`tests/hiringStageFlow.test.js` (read → propose in the Bitrix topic → press →
move), `tests/hiringStageCrmCreate.test.js` (a stateful fake Bitrix: neither
contact nor deal, an existing contact, an existing deal, every ambiguous and
not-certain case, timeouts before and after Bitrix acted, a refusal, the same
driver posted twice, Skip), `tests/hiringStageIdentity.test.js`,
`tests/hiringStageWorker.test.js` (blocked without the topic),
`tests/hiringStageQueue.test.js`, `tests/hiringStageStorePg.test.js`,
`tests/hiringStageCrmRecordsPg.test.js` (the claim, busy per phone, notices,
the topic setting), `tests/safetyApprovalSettingsRoute.test.js` and
`admin/src/pages/settings/SafetyApprovalsTab.test.jsx`.
