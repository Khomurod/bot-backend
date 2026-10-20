# Safety Approvals — Safety's hire decisions, posted from the recruiting group

**Read this before touching** `lib/safetyApprovals/*`,
`services/safetyApprovals/*`, `database/safetyApprovals/*`,
`bot/handlers/safetyApprovalHandlers.js`,
`server/routes/settings/safetyApprovalRoutes.js` or
`admin/src/pages/settings/SafetyApprovalsTab.jsx`.

## What it does

In the recruiting group a recruiter posts a driver candidate — an album of
the CDL (front and back) and the medical card, with the name, phone and
experience as text — or a team of two. Safety checks the driver and REPLIES
to that post with the PSP / MVR / CLH reports and a sentence ("We can hire
him", "good to go", "can't take him, 3 accidents").

The bot listens to the group **quietly** — Safety Approvals never writes in
the conversation — and posts each decision, separately, in the group's
"approved / not approved" topic as **one block of files**: the CDL as a file,
then every file Safety attached, with the status, the driver's name and phone,
Safety's words, who posted and who decided, and a link to the original post
under it. This is what the owner asked for on 16 October 2026: "all in one
block of files", "all of Safety's PDFs", and "an unclear reply posts nothing".

The same captured messages feed a second, separately switched feature: the
**Bitrix stage proposals**, which DO reply in General ("move <driver> to
<stage>?" with a button). See [`hiring-stage-proposals.md`](hiring-stage-proposals.md).

## The rules, and why each one exists

A wrong **APPROVED** in that topic is a driver Safety refused being onboarded.
Every rule below closes a way to post one.

1. **Off by default, and off means off.** `safety_approval_settings.enabled`
   is FALSE and cannot be saved TRUE without a **validated** group, a topic,
   and at least one Safety person (`missingForEnable`). Nothing is stored from
   any chat until then. No environment variable switches it on. Changing the
   group switches it off and forgets the topic.
2. **Only the people named as Safety decide.** `safety_user_ids` is a list the
   administrator ticks in Settings. A recruiter writing "approved" is stored and
   never read as a decision.
3. **Only a REPLY is an answer.** A Safety message counts only when it replies
   to something (or belongs to an album where an item does). In a forum group
   Telegram marks every topic message as a "reply" to the topic's root; that is
   not a reply (`lib/safetyApprovals/messageShape.js`).
4. **The post must have been seen.** A reply to a message from before the
   feature was on has no CDL and no names to check against: `no_post`.
5. **Safety is given time to finish.** A reply with no words yet, or no files
   yet, and under two minutes old waits (`WAIT_FOR_REST_SECONDS`) without
   spending an attempt — Safety often sends the PDFs and the sentence as two
   messages. Every new item or edit re-arms a 30-second settle delay.
6. **A model reads the language; the messages decide the facts.**
   `lib/safetyApprovals/reading.js` keeps a candidate only if every part of the
   name appears in the post, Safety's words or Safety's file names — or, in a
   post with no name in writing at all, the ONE candidate the model read off a
   CDL photo it was shown (captioned "name read from the CDL", with that CDL
   attached so a person can check it; two such names stay dropped); keeps a
   phone only if the recruiter typed it; drops an "approved" when the words
   about that driver carry a refusal or a question mark; in a team counts a
   decision only for a driver Safety's **words** name by a name the other
   driver does not share (a file name is not naming; "both"/"them" is); and
   drops two different answers for one driver. Anything dropped posts nothing,
   and the review is `unclear`.
7. **The caption carries nothing a model wrote.** Status and name come from the
   verified reading, the phone is the recruiter's, and the reason is Safety's
   own words quoted verbatim (`lib/safetyApprovals/announcement.js`).
8. **The same decision is never posted twice; a changed one is.**
   `safety_approval_announcements` remembers the last decision per (post,
   driver). An edit from "approved" to "not approved" posts again. The right
   to post is **reserved before the send**, under an advisory lock, so two
   workers cannot both post and a database failure after Telegram accepted
   the post cannot post it again. A send Telegram refused gives the
   reservation back. This is at-most-once on purpose: a duplicate APPROVED
   is worse than a missing one, which shows in Settings.
9. **In a team, a driver's files are that driver's.** A file whose name names
   the other driver is not attached (`documentsFor`).
10. **The recruiting group is not a driver group.** Every group the bot joins
    is registered as `driver`; this one is moved to `recruitment` on save and on
    the first captured message, so home-time, retention and driver broadcasts
    leave it alone. Only a `driver` row is moved — another type was chosen by a
    person.

## How it flows

```
bot message / edited_message
  → bot/handlers/safetyApprovalHandlers.js      (thin; always next(); never throws)
  → services/safetyApprovals/captureService.js  (chat gate → store → Safety reply? → enqueue + wake)
  → services/safetyApprovals/worker.js          (queue wake scheduler; withRunRecord('safety_approvals'))
  → services/safetyApprovals/reviewer.js        (post bundle → Safety bundle → wait? → photos → AI → verify → post)
      ├─ services/safetyApprovals/aiReading.js  (capability `safety_approval_reading`, photos as image parts)
      └─ services/safetyApprovals/announcer.js  (sendMediaGroup of documents into message_thread_id)
```

- **The post** (`lib/safetyApprovals/bundle.js`) is the replied message plus
  its album, plus — only when that has no words or no pictures — the same
  recruiter's non-reply messages within three minutes. A recruiter posting two
  complete drivers in a row has made two posts. Safety replying to its own
  earlier message is followed back to the post (three hops at most).
- **The CDL is uploaded again.** Telegram will not mix a photo with documents
  in one album and will not re-send a photo's file id as a document, so the
  CDL's bytes (already fetched for the model) go up as `CDL - <name>.jpg`.
  Safety's files are re-sent by file id; no bytes are downloaded for them.
- **Failures retry, then stop.** An AI outage, a Telegram error or photos that
  will not download retry at 1, 5, 15, 30 and 60 minutes; after six attempts or
  a day the review is `gave_up` and shows in Settings → Safety Approvals.
  Photos can only go to a vision model (Gemini); if none has answered for three
  attempts, the reply is read from the words alone — still verified — and the
  decision is posted **without the CDL file** rather than not at all.
- **A reply edited mid-read is read again.** The queue row's `revision` goes up
  on every enqueue; a worker finishes only the revision it claimed, and a stale
  finish gives the lease back.

## Data

Migration `0069_safety_approvals.sql`:

| Table | What it holds |
|---|---|
| `safety_approval_settings` | the single settings row (group, topic, Safety ids, switch) |
| `safety_approval_messages` | every message in the group, verbatim, with Telegram file ids — **deleted after 60 days** by the worker |
| `safety_approval_reviews` | one row per Safety reply: the queue, then the verified outcome (never the raw model answer) |
| `safety_approval_announcements` | what was posted, per post and driver |

No file bytes are stored, and nothing logs message text — these rows are
drivers' names and phone numbers.

## Setting it up (Settings → Safety Approvals)

1. Make the bot an **admin** of the recruiting group (or turn its privacy mode
   off in BotFather) — otherwise it never sees the posts. Validation says so,
   and saving such a group is refused.
2. Paste the group's chat id, **Validate**, **Save group**.
3. Copy a message link from the approved / not approved topic, paste it,
   **Save topic**, and **Send a test message** to prove the bot may post there.
4. Tick the Safety people, **Save Safety people**, then switch it on.

## Tests

`tests/safetyApprovalReading.test.js`, `tests/safetyApprovalAnnouncement.test.js`,
`tests/safetyApprovalReviewer.test.js`, `tests/safetyApprovalCapture.test.js`,
`tests/safetyApprovalSettingsRoute.test.js`, `tests/safetyApprovalStorePg.test.js`
and `admin/src/pages/settings/SafetyApprovalsTab.test.jsx`.
