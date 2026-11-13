# Hiring stage proposals — Bitrix deal stages, proposed in the recruiting group

**Read this before touching** `lib/hiringStages/*`, `services/hiringStages/*`,
`services/bitrix24DealStages.js`, `database/hiringStages/*`,
`bot/handlers/hiringStageHandlers.js` or
`admin/src/pages/settings/HiringStagesCard.jsx`.

**Since 13–14 November 2026** (the owner, "hiring deal names"): a deal the bot
creates is titled in **Safety's spelling and order** (rule 16); a conversation
that already has a deal — open or closed — **never creates another** and never
asks for one (rule 17); a **rejected** candidate with no deal gets nothing
created (rule 18); and a deal titled **"No name"** is offered a rename on the
card, written only after a press (rule 19).

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

1. **A model proposes; a person moves the deal.** `crm.deal.update`
   `STAGE_ID` is called from exactly one place (`services/hiringStages/actions.js`),
   after somebody in the group pressed **Move**. There is no automatic mode.
   (`crm.deal.update` `TITLE` and `crm.contact.update` are called only from
   `services/hiringStages/rename.js`, after a press on ✏️ Rename — rule 19.) Creating a
   missing deal (rule 13) is not moving one: a created deal starts at "Sent
   to Safety", and every later stage is still a proposal.
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
12. **Read in General, written in the Bitrix topic — ONE CARD PER DRIVER**
    (owner, 11 November 2026: "the bot must not spam the group"). Everything
    about one candidate is one message (`services/hiringStages/card.js`,
    `hiring_stage_cards`, migration 0101): the driver's name — set once, from
    the post — with a link to the post in General, a short history (the last
    six lines) and the question open now with its buttons. A new question or
    a line of news (deal created, two people match, a Bitrix error) re-posts
    the card at the BOTTOM of the topic and deletes the previous copy (one
    Telegram will not delete is edited to point below); an answer — Move, No,
    Skip, search again — edits the card in place. Sent with
    `message_thread_id` = `safety_approval_settings.bitrix_topic_id`, never as
    a reply (a reply cannot cross topics). A line of news is shown once per
    conversation and key (`hiring_stage_notices`, reserved before the send).
    A question posted before cards existed (some still sit in General) is
    closed by editing its own message.
13. **A missing deal is created only for a CERTAIN candidate**
    (`lib/hiringStages/identity.js`): exactly one driver's name read off the
    post without a model (not a team, no name-shaped line in small letters),
    exactly one phone a recruiter typed, and — when the model named the driver
    — a name made of the post's words. Then, in Bitrix
    (`services/hiringStages/crmCreate.js`): the contact holding that phone is
    reused when its first and last name are among the post's words; two
    contacts holding it, another person's name on it, or this name on a
    contact under another phone **creates nothing** (`blocked`) — the recruiter
    is asked, with the reason. A new deal starts at **"Sent to Safety"**
    (owner, 11 November 2026 — a candidate posted in the recruiting group IS
    one sent to Safety; a pipeline without that stage creates nothing), titled
    with the DISPLAY name (rule 16), on the configured deal pipeline (default 0).
    Bitrix's own automation carries a deal from that stage into the Safety
    pipeline, so nothing more is proposed in the read that created it: the
    conversation is read again two minutes later, and the next step is
    PROPOSED with Move / No in whatever pipeline the deal is then. A
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
15. **Approval is not hiring.** A stage whose name says "hire" is proposed
    only when the quoted words say the driver was hired, arrived or started
    orientation (`lib/hiringStages/proposal.js`, `hired_needs_arrival`); the
    model is told the same. Until 11 November 2026 every `#Approved` on a new
    deal became "move to Hired?".
16. **The name WRITTEN is Safety's spelling, read by rules**
    (`lib/hiringStages/displayName.js`; owner, 13–14 November 2026: deals were
    titled "Goowin Leah Ann", "Johnes Destin", "Thelamon Marcson Jose" while
    Safety wrote "LEAH GOODWIN APPROVED"). Safety's own messages in the
    conversation (`safety_user_ids`, their TEXT — never a model's answer, never
    a recruiter's words, never the post) are searched for a run of consecutive
    words that are the post's name words: equal ignoring case, or — both five
    letters or more — one letter edit apart. Fewer than TWO matched words is
    no match. Where they differ, **Safety's spelling wins** (owner decision f).
    Order: a run covering every post word → Safety's order; a run whose LAST
    word is the post's FIRST word → the post was surname first, as on a CDL,
    so "FIRST MIDDLE … LAST" ("Goowin Leah Ann" + "LEAH GOODWIN" → "Leah Ann
    Goodwin"); anything else → the post's order, never guessed. No Safety run
    → the post's line exactly as before. Title case and suffixes as before.
    The contact's NAME is every word but the last, LAST_NAME the last; the
    deal's TITLE the whole display name. The words a contact or deal is FOUND
    by stay the post's, and so does the card's header. The display name is
    stored on the creation claim (`hiring_stage_crm_records.display_name`), so
    a creation resumed after a timeout writes the name it started with.
17. **Never create a deal the conversation already has** (owner, 13–14
    November 2026: a conversation whose deal was moved to Lost was read again
    on a new reply, saw no OPEN deal and asked people to "create the deal" —
    and could have created a second). Before any creation
    (`services/hiringStages/noDeal.js`), the deals this conversation already
    knows — on its proposals, or created for it — are read again
    (`crm.deal.get`, read only). Open: it is the deal, and the stage is
    proposed on it. Closed: nothing is created, nobody is asked, and ONE card
    line says `the deal "<title>" is closed (<stage>) — nothing to create`
    (once per deal). A known deal Bitrix no longer has (deleted — Bitrix
    answers `crm.deal.get` with HTTP 400 "Not found", which the client reads
    as "no such deal", not as Bitrix failing) is skipped like one never known.
18. **A rejected candidate with no deal gets nothing** (owner decision g):
    Safety's newest hashtag in the conversation is `#NotApproved` (by rule,
    `lib/hiringStages/conversation.js` `safetyRejected`), or the stage read is
    a failure stage (Lost / REJECTED). No contact, no deal, no "please create
    it" — one card line "Rejected — no deal created". (Johnes, deal 6533, was
    created and then moved to REJECTED.)
19. **A placeholder deal title is renamed BY BUTTON ONLY**
    (`lib/hiringStages/placeholder.js`, `services/hiringStages/rename.js`;
    owner, 13–14 November 2026: deals titled "No name" were found by phone and
    moved but never renamed). When the deal the card is about is titled with
    a placeholder — empty, "No name" in any spacing (production has "No name"
    and two spaces), or digits only — and is in a hiring pipeline (never
    pipeline 3 "DRIVER RELATION", whose titles the Board ↔ Bitrix check owns,
    nor 33 "HOMETIME MONITORING"), and the post has ONE certain driver's name
    (`lib/hiringStages/identity.js` `certainDisplayName` — no model needed;
    a deal found by phone is offered right after the read, whatever the read
    says) and the conversation has exactly ONE phone (with two, the deal found
    may be the other number's owner, and a "No name" deal must not take this
    driver's name), the card offers `✏️ Name in Bitrix: “No name” → “<display name>”?` with
    **[✏️ Rename] [Keep as is]** — once per conversation and deal, under the
    stage question and kept while it changes (the card's "aside", edited in
    place). Anyone the Move button allows may press; the press is claimed once
    (`hiring_stage_renames`, `pending → applying`), the deal is READ AGAIN:
    gone, closed, or no longer in a hiring pipeline (moved into pipeline 3
    since the offer) → nothing is written. Its TITLE is written only while it
    is still exactly the placeholder shown (compared as text: Bitrix reads an
    empty TITLE back as null) — otherwise "renamed meanwhile — left as is",
    even when a person typed the very same name. The title write is recorded
    the moment Bitrix confirms it (`title_written`), so a press that then
    fails at the contact says the deal WAS renamed, and the next press
    finishes the contact without writing the title twice. The deal's contact
    (`CONTACT_ID`) is then read and its NAME / LAST_NAME written only when its
    own name is a placeholder too (both empty, or "No name") — a real name is
    never overwritten. One write per field. Who pressed and the outcome are
    kept on the row (`decided_by_*`, `contact_renamed`); **Keep as is** is
    recorded and the buttons go. Bitrix failing gives the claim back. Rename
    decisions live in `hiring_stage_renames`, NOT in `hiring_stage_proposals`:
    a conversation has at most one open proposal, and a rename question stays
    open beside a Move question — an audit of who acted on a candidate reads
    both tables.

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
       → verifyStageAnswer → deal by name (if none yet)
       → no deal? noDeal.js: Skip → the conversation's own deal (open: use it; closed: one line)
         → rejected: one line → not certain: ask → certain: crmCreate.js (contact + deal, display name)
       → a placeholder title? rename.js offers ✏️ Rename / Keep as is on the card (written only on a press)
       → stagePlan.js (carry the stage to the deal's pipeline by NAME)
       → propose.js, in the Bitrix topic (groupMessages.js), each with the driver and a link to the post:
         ONE CARD per driver (card.js): 👤 name · post link / history / the open question
           "Move to STAGE?" [Move] [No]
           or "No open deal — <reason> — <recruiter>, please create it" [Deal created — search again] [Skip]
           lines once each: "Deal created …" · "N people in Bitrix match this name" · "Bitrix error …"
             · "the deal … is closed (Lost) — nothing to create" · "Rejected — no deal created"
           aside: "✏️ Name in Bitrix: “No name” → “…”?" [✏️ Rename] [Keep as is]
  → button press: bot/handlers/hiringStageHandlers.js (thin) → services/hiringStages/actions.js
       (rn / rk → services/hiringStages/rename.js)
```

- **A conversation is named by its post** — the message the reply chain leads
  back to; an album by its first item, so replies to the CDL's front and back
  are one conversation. A chain that leads to a message the bot never saw is
  not queued.
- **A burst is read once.** Every new message re-arms a TEN-MINUTE settle delay
  (90 seconds until 11 November 2026)
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

Migrations `0076_hiring_stage_proposals.sql`,
`0100_hiring_stage_bitrix_topic_and_crm_records.sql`, `0101_hiring_stage_cards.sql`
and `0104_hiring_display_names_and_renames.sql`:

| Table / column | What it holds |
|---|---|
| `safety_approval_settings.stage_proposals_enabled` | the switch (Settings → Safety Approvals → 5) |
| `safety_approval_settings.bitrix_topic_id` | the Bitrix topic every Bitrix message goes to; cleared when the group changes; may not be the approvals topic |
| `hiring_stage_threads` | one row per conversation: the queue, and what the last read concluded (never the raw model answer) |
| `hiring_stage_proposals` | what the bot posted and what became of it — who pressed, when, from which stage to which; `note` is why a deal was not created automatically |
| `hiring_stage_crm_records` | the claim on creating a contact + deal: one per conversation, at most one in flight per phone, each step recorded before its Bitrix call |
| `hiring_stage_notices` | which line of news ("created", "ambiguous", "bitrix_error:<revision>") was shown about a conversation |
| `hiring_stage_cards` (migration 0101) | the one card per driver: its message now, the name (set once), the history, the question it shows — and since 0104 the `aside` (the rename offer) |
| `hiring_stage_crm_records.display_name` (0104) | the name a creation writes (rule 16), stored at the claim; `driver_name` stays the post's, to find by |
| `hiring_stage_renames` (0104) | a placeholder-title rename offered, and who answered it how (`decided_by_*`, `title_written`, `contact_renamed`): once per conversation and deal, one open per conversation |

Proposals, creation records, notices and rename offers carry a driver's name and phone, so
closed ones are **deleted after 60 days**, like the captured messages;
finished queue rows too (a creation still in flight is kept). Nothing logs
message text or a phone number.

## Bitrix

`services/bitrix24DealStages.js` uses the same inbound webhook as the lead
push (Settings → Bitrix24, which must be **enabled**). Every write below is
recorded in Monitoring → Logs by the client itself ([activity-log.md](activity-log.md)):
Move and ✏️ Rename with the presser's Telegram id (`hiring_stage.move`,
`hiring_stage.rename`), a creation as `automatic` with the chat and post as
evidence (`hiring_stage.create`) — never the candidate's phone. The
webhook needs the `crm` scope with write access. Reads: `crm.duplicate.findbycomm`,
`crm.contact.list`, `crm.contact.get`, `crm.deal.list`, `crm.deal.get`,
`crm.status.list`. Writes to an existing record, each only after a press and a
fresh read: `crm.deal.update` `STAGE_ID` (Move); since 13–14 November 2026
`crm.deal.update` `TITLE` of a placeholder title (✏️ Rename, only from
`services/hiringStages/rename.js`) and `crm.contact.update` `NAME` /
`LAST_NAME` of that deal's contact when its own name is a placeholder (the same
press). And, since November 2026,
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
`tests/hiringStageCard.test.js` (one message per driver: re-post and delete,
edit in place, once per key), `tests/hiringStageNames.test.js` (the display
name — the Goowin example, post-only order, fewer than two words, never a
model's spelling — Safety's #NotApproved, placeholders and pipelines, the
card's words), `tests/hiringStageDealNames.test.js` (end to end: the created
title, a resumed creation, the conversation's own closed or open deal, a
rejection, the rename offered and pressed, renamed meanwhile, a real contact
name, Keep as is, the Board's pipeline), `tests/hiringStageRenamePress.test.js`
(an empty title, a deal moved into pipeline 3 or closed after the offer, the
same name typed by a person, the title written before the contact failed, a
deleted deal, offered with no move but never with two phones, a deleted known deal),
`tests/hiringStageRenamesPg.test.js`
(migration 0104),
`tests/hiringStageQueue.test.js`, `tests/hiringStageStorePg.test.js`,
`tests/hiringStageCrmRecordsPg.test.js` (the claim, busy per phone, notices,
the topic setting), `tests/safetyApprovalSettingsRoute.test.js` and
`admin/src/pages/settings/SafetyApprovalsTab.test.jsx`.
