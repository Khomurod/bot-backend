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

**Since 20 October 2026 the team marks each decision with a hashtag:**
`#Approved` or `#NotApproved`, as a reply to the driver's post. A hashtag
decides with **no model at all**; the driver is read off the post. The words
alone ("approved", "not approved") still count — a forgotten hashtag never
loses a decision — and are read by a model, as before. Any other Safety
message ("on it", "CLH sent", a PDF) is not a decision and costs nothing.

Each decision is posted, separately, in the group's "approved / not approved"
topic as **the driver's post, the way the recruiter sent it**: the post's photos
(the CDL), and as their caption the recruiter's own words — job, full name,
phone, experience — then `✅ APPROVED by Aubrey Davis` (or `❌ NOT APPROVED`),
Safety's reason when one was written, the recruiter and a link to the original
post. Safety's MVR / PSP / Clearinghouse files are **not** re-posted. The owner
chose this on 20 October 2026, and asked for it "this very second": a hashtag
goes out about five seconds after it is written — no model, no download, the
photos re-sent by their Telegram file ids.

When the bot **cannot tell which driver** a decision is about, it does not
guess and does not drop it: it **asks Safety in General**, once, as a reply to
their message ("Which driver is this about? Reply to the driver's post with
#Approved or #NotApproved"). That is the only thing Safety Approvals ever
writes in the conversation.

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
3. **Only a decision is read.** A Safety message is queued only when it
   carries `#Approved` / `#NotApproved` (any spelling: `#notapproved`,
   `#Not_Approved`…) or the words "approved" / "not approved"
   (`lib/safetyApprovals/trigger.js`). A question ("is he approved?") is never
   a decision and is not answered. In a forum group Telegram marks every topic
   message as a "reply" to the topic's root; that is not a reply
   (`lib/safetyApprovals/messageShape.js`).
4. **Which post: the reply, or the conversation just before.** A reply names
   its post. A decision written on its own is matched to the posts the last
   six General messages before it belong to (`services/safetyApprovals/
   postLocator.js`): one such post is the answer; several are put to a model
   that may only PICK one by label; none, or a model that cannot tell, means
   **Safety is asked** — never a guess. A reply to a post from before the
   feature was on is asked about too.
4a. **A hashtag decides — for the driver(s) it names.** In a one-driver post it
   is that driver. In a team post it must name one ("#Approved Darnell"), or
   say "both"; a team hashtag naming nobody, or both hashtags for one driver,
   is asked about (`lib/safetyApprovals/hashtagDecision.js`). The name is read
   off the post without a model (`lib/safetyApprovals/postDetails.js`); only a
   post with no readable name asks a model — for the names, never the decision.
5. **No waiting for Safety's files.** They are not posted, so nothing waits
   for them. A decision is read 5 seconds after its last piece arrives (an
   album comes item by item; each item and each edit re-arms the delay).
6. **Without a hashtag, a model reads the language; the messages decide the facts.**
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
   the review is `unclear`, and Safety is asked.
7. **The post carries nothing a model wrote.** The caption is the recruiter's
   words verbatim (an SSN taken out, should one have been pasted), the status
   is the hashtag (or the verified reading) and who wrote it, the reason is
   Safety's own words beside the hashtag (`lib/safetyApprovals/announcement.js`).
   In a team post the status names whose decision it is.
7a. **A post Safety forwarded is the recruiter's.** Telegram makes a forwarded
   message the forwarder's; the bot keeps who it is really from
   (`forward_origin`, migration 0077) and treats it as that recruiter's post,
   gathering the other pieces forwarded from the same author around it ("old
   cdl") — never anything Safety wrote themselves. This is why John Bolling's
   `#Approved` on 20 October posted nothing before the change.
8. **The same decision is never posted twice; a changed one is.**
   `safety_approval_announcements` remembers the last decision per (post,
   driver). An edit from "approved" to "not approved" posts again. The right
   to post is **reserved before the send**, under an advisory lock, so two
   workers cannot both post and a database failure after Telegram accepted
   the post cannot post it again. A send Telegram refused gives the
   reservation back. This is at-most-once on purpose: a duplicate APPROVED
   is worse than a missing one, which shows in Settings.
10. **The recruiting group is not a driver group.** Every group the bot joins
    is registered as `driver`; this one is moved to `recruitment` on save and on
    the first captured message, so home-time, retention and driver broadcasts
    leave it alone. Only a `driver` row is moved — another type was chosen by a
    person.

## How it flows

```
bot message / edited_message
  → bot/handlers/safetyApprovalHandlers.js      (thin; always next(); never throws)
  → services/safetyApprovals/captureService.js  (chat gate → store → Safety DECISION? → enqueue + wake)
  → services/safetyApprovals/worker.js          (queue wake scheduler; withRunRecord('safety_approvals'))
  → services/safetyApprovals/reviewer.js        (decision? → post → Safety bundle → wait? → photos → decide → post)
      ├─ services/safetyApprovals/postLocator.js (the replied post, or the post the last messages were about)
      │    └─ services/safetyApprovals/aiContext.js  (several posts in play: a model PICKS one by label)
      ├─ services/safetyApprovals/decide.js     (hashtag → no model; words → aiReading.js, verified)
      │    └─ services/safetyApprovals/aiReading.js  (capability `safety_approval_reading`, photos as image parts)
      └─ services/safetyApprovals/announcer.js  (the post's photos + caption into message_thread_id;
                                                 or the question to Safety in General)
```

- **The post** (`lib/safetyApprovals/bundle.js`) is the replied message plus
  its album, plus — only when that has no words or no pictures — the same
  recruiter's non-reply messages within three minutes. A recruiter posting two
  complete drivers in a row has made two posts. The post Safety answered is
  the start of the reply chain, whoever wrote each step: Safety replying to a
  recruiter's "could we schedule his drug test?" is about the post that
  question follows.
- **Nothing is downloaded to post.** The post's photos are re-sent by the
  file ids the bot captured (pictures sent "as files" as documents; Telegram
  will not mix the two). Photos are downloaded only when a model must look at
  them — a decision without a hashtag.
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
| `safety_approval_reviews` | one row per Safety decision message: the queue, then the verified outcome (never the raw model answer). `post_message_id` is NULL for a decision written on its own (migration 0077) |
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
`tests/safetyApprovalReviewer.test.js`, `tests/safetyApprovalHashtag.test.js`,
`tests/safetyApprovalTrigger.test.js`, `tests/safetyApprovalCapture.test.js`,
`tests/safetyApprovalSettingsRoute.test.js`, `tests/safetyApprovalStorePg.test.js`
and `admin/src/pages/settings/SafetyApprovalsTab.test.jsx`.
