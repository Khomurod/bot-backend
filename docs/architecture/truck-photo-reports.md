# Truck Photos — the hand-over and return photos, as a PDF to one person

**Read this before touching** `lib/truckPhotos/*`, `services/truckPhotos/*`,
`database/truckPhotos/*`, `bot/handlers/truckPhotoHandlers.js`,
`server/routes/settings/truckPhotoRoutes.js`,
`admin/src/pages/settings/TruckPhotosTab.jsx` or migration
`0096_truck_photo_reports.sql`.

## What it does (the owner, 6 November 2026)

In a **driver's** group (`groups.group_type = 'driver'`) the driver or a fleet
manager sends photos of the truck when it is handed over or comes back — an
album of ten or twenty, single photos, or both. Somebody then writes
**`outbound`** (hand-over) or **`inbound`** (return), as a reply to a photo or
as a message of its own.

Wenze puts those photos into a PDF and sends it to **one person**, privately —
the Telegram user id saved in Settings → Truck Photos. Once the PDF has been
delivered, the bot sets a **👍** reaction on the word. That reaction is the only
thing the bot ever does in a driver's group: **nothing is ever written there.**

**Off by default.** It cannot be switched on until the recipient is saved and a
test message has reached them.

## The rules, and why each one exists

1. **Who may mark.** Anybody **except the group's own driver** — the person
   handing the truck over is not the one who signs it off. The exclusion
   applies only where it can actually be told: a **solo** group (the profile
   names one driver) whose driver's Telegram account is **known** — every open
   `driver_person_telegram_identities` row of the person on the chat, plus
   `driver_profiles.telegram_user_id` (`docs/architecture/telegram-identity.md`;
   a username is never evidence). A **team** group (a second driver on the
   profile, the same test the identity sweep uses) accepts the drivers too; a
   driver with no linked account, or a group that cannot be read, accepts
   anybody (`lib/truckPhotos/whoMayMark.js`). The driver's own word is ignored
   silently — no record, no message.
2. **The word.** Whole word, any letter case (`lib/truckPhotos/trigger.js`).
   **Bare** means the message is only the word, give or take "truck", a "#",
   emoji and punctuation (`outbound`, `#Inbound 🚛`). Both words in one message
   is not a trigger. An edited message is not read.
3. **Which photos** (`lib/truckPhotos/selectPhotos.js`):
   - a **reply to a photo** takes that photo's album and the photos around it,
     from `lookback_hours` before the photo to `lookback_hours` after it, and
     never past the word (the owner, 6 November 2026: a reply to a week-old
     photo is about that day, not the whole week since); a photo whose
     caption *is* the word anchors itself, so the rest of its album counts;
   - **videos** are chosen by the same rules (see "Videos" below);
   - a **plain word** takes the last `lookback_hours` (3 by default, 1–24);
   - from any sender — driver and fleet manager alike — never the bot;
   - **photos after the word are ignored**, by Telegram's message order; a new
     word makes a new PDF;
   - **never twice**: a photo already in a delivered PDF (`report_id`) is left
     out, and one picture forwarded twice is in once;
   - in the order they were sent.
4. **Claim before acting.** Telegram redelivers an update it thinks was not
   handled. `truck_photo_reports` is UNIQUE on `(chat_id, trigger_message_id)`
   and the row is claimed (`pending`) before anything else is done, so a
   redelivered word never makes a second PDF. The report then waits **5
   seconds** (an album arrives item by item) and runs **one at a time** — each
   holds its re-encoded photos in memory. The bot's handler never waits for
   it.
5. **Not stored.** The buffer `driver_group_photos` holds **Telegram file ids
   only, never bytes** (the database's monthly transfer allowance,
   `docs/brief/database-transfer.md`), and is deleted after **30 days** by the
   hourly data-retention pass. The **PDF is never stored** — not in the
   database, not on disk: each photo is downloaded by its file id
   (`services/telegram/fileDownload.js`, 20 MB cap), re-encoded with sharp to
   ~1600 px, quality ~80, turned the way the phone held it, put on a page with
   its caption (time in Chicago, who sent it), assembled with `pdf-lib`, sent
   from the buffer and dropped. What stays is the record that it was sent.
6. **Several PDFs past sixty photos** (`max_photos_per_pdf`, 60 at most, so a
   part stays under Telegram's 50 MB): "Part 1 of 2", each with its own cover.
   File name `outbound_<unit>_<YYYY-MM-DD>[_part1of2].pdf`. At most 240 photos
   (four PDFs) per word — each is held in memory until its PDF is sent — the
   latest kept, and the cover says how many earlier ones were left out.
7. **The cover** (English, `lib/truckPhotos/pdfLayout.js`): OUTBOUND or
   INBOUND; the driver; the truck as Wenze knows it — number, fleet and owner
   (`lib/drivers/truckIdentity.js`: by the truck an owner-operator, by the
   driver a company driver); the chat; when it was marked (America/Chicago);
   who marked it; photos N (excluded M). An **inbound** cover says
   "Outbound on <date>, <n> photos" — the group's last *delivered* outbound — or
   "No outbound on record". Every string is made printable by the PDF's built-in
   font (Cyrillic in Latin letters, emoji dropped).
8. **Failures go to the recipient, privately, in fixed words**
   (`lib/truckPhotos/failureText.js`): no photos, only photos already sent,
   every photo left out, "could not tell", no model to ask, nothing could be
   downloaded, not delivered, a part not delivered, too large, interrupted by a
   restart. Each says the chat, who marked it and when, why, and what would fix
   it — no link, no token, no message text. The same "why" is stored in
   `truck_photo_reports.reason` and shown in Settings. "Not about the truck"
   and "switched off meanwhile" are recorded and told to nobody.
9. **A photo Wenze saw late.** A bot cannot read a chat's history: it knows a
   photo only from the moment it arrives while Truck Photos is on. A reply to a
   photo sent before that — the first test, a reply to an album from 27
   October, gave a PDF of one photo out of four — hands over THAT photo with
   the reply, never the rest of its album. When the replied-to photo enters
   the buffer only with the reply and is at least two minutes older than the
   word (`LATE_AFTER_SECONDS`: a photo sent seconds earlier may simply be
   handled a moment later), the PDF still goes out, and its **cover and
   caption say** that the photo was sent before Wenze saw it, that photos sent
   with it may be missing, and to forward them to the group and write the word
   again. The same sentence is in `truck_photo_reports.reason`.
10. **A claim a stopped process left behind** is closed by the hourly pass on
   the scheduler's retention tick (`services/truckPhotos/sweep.js`): still
   `pending` after 30 minutes and not among the reports this process has queued
   or running (they wait behind each other), it becomes `failed` and the
   recipient is told. A report's downloads and model calls stop after 12
   minutes (what was not reached is counted, or stays unfiltered); each send
   has its own three.

## Videos (the owner, 6 November 2026)

A video of the truck — a video, a round video note, or a video sent as a file;
not a GIF — is remembered like a photo (file id, length, and the file id of the
small preview Telegram made) and listed in the PDF as a **link to its message**
(`https://t.me/c/<chat>/<message>`, `lib/truckPhotos/videoLinks.js`). The
person who receives the PDFs is in every driver group (the owner's answer), so
the link opens for them; a basic group, which has no message links, gets the
chat and the time instead.

- **No video is downloaded or stored.** The videos page
  (`services/truckPhotos/pdfVideos.js`, right after the cover, in part 1) shows
  each video's preview — downloaded once, a few dozen KB, at most 2 MB — its
  number, length, time and sender, and the link as a real link annotation.
- The cover says "Videos: N", the caption and an inbound's "Outbound on" count
  photos and videos, and `truck_photo_reports.video_count` keeps the number.
- **The model never sees a video**; the photo filter is unchanged.
- **Videos alone make a PDF** (a cover and the videos page). Photos that could
  not be downloaded do not cost the videos their PDF.
- At most 60 videos per word.

## What the AI does, and does not

Capability **`truck_photo_handover`** (Settings → AI → AI Tasks; verdict in
[`ai-decisions.md`](ai-decisions.md)), through `services/ai/router.js`:

- **(a) Is the message about the truck?** Asked **only when the message is not
  bare** — "outbound load from Chicago" is about freight. The text is untrusted:
  fenced and sanitised (`lib/ai/untrustedText.js`). Only a **sure yes**
  (confidence ≥ 70) makes a PDF; a sure no is recorded as `not_a_handover` and
  nothing is sent; anything else is `unclear` — no PDF, and the recipient is
  told "could not tell".
- **(b) Which photos are clearly not the truck** — a bill of lading, a receipt,
  a screenshot, a selfie. Eight at a time, each through
  `services/aiImagePrep.js` (a smaller copy; the PDF uses its own), as image
  parts the router gives only to a model that can see. **It may only exclude:**
  an index outside the batch is ignored, a photo is left out only at
  confidence ≥ 80, a photo it is unsure about or says nothing about stays in.
- **No model** (none configured, the capability switched off, every provider
  failing): a **bare word** still makes a PDF of **every** photo, unfiltered; a
  word with more around it makes **no PDF** and the recipient is told Wenze did
  not guess.
- It **cannot** add a photo, write a word in the PDF or the group, choose the
  recipient, or touch a driver's record. `truck_photo_reports.ai_assisted` is
  written explicitly on every row (FALSE at the claim), with `ai_provider`.

## Setting it up (Settings → Truck Photos)

1. The person who will receive the PDFs opens the bot in Telegram and presses
   **Start** — a bot cannot message somebody who never has (Telegram answers
   403 "bot can't initiate conversation with a user"). Start in a private chat
   opens the bot's anonymous-feedback prompt; nothing needs to be typed there,
   and the PDFs arrive in that same chat. The bot must already see the driver
   groups' messages (admin, or privacy mode off — Settings → Group Access), as
   Home Time needs.
2. Paste their **Telegram user id** (numbers only, a person not a group),
   **Save recipient**, then **Send test message**. A refusal is explained in
   words; only a message that arrived records `recipient_verified_at`.
3. Optionally change how far back a plain word looks (1–24 hours).
4. Switch it on. Changing the recipient switches it off again.

The routes are under `/api/settings/truck-photos*`, behind `admin.full_access`
like every settings route; errors carry `error`, the test's verdict comes back
with 200.

## Data

Migrations `0096_truck_photo_reports.sql` and `0097_truck_photo_videos.sql`
(videos: `kind = 'video'`, `duration_seconds`, `thumb_file_id`, and
`truck_photo_reports.video_count`):

| Table | What it holds |
|---|---|
| `truck_photo_settings` | the single settings row; `enabled` cannot be TRUE without a recipient and `recipient_verified_at` (CHECK) |
| `driver_group_photos` | the buffer of photos and videos: file ids, sender, album, time, a video's length and preview, `report_id` once sent — **deleted after 30 days** |
| `truck_photo_reports` | one row per word: the claim, then `sent` / `failed` / `no_photos` / `not_a_handover` / `unclear`, counts, the reason, `ai_assisted`. Kept |

Run ledger key `truck_photo_reports` (`configurable`, not critical): each report
and the hourly pass; `blocked` while switched off.

## Tests

`tests/truckPhotoTrigger.test.js`, `truckPhotoWhoMayMark`, `truckPhotoSelect`,
`truckPhotoChunk`, `truckPhotoLayout`, `truckPhotoCapture`,
`truckPhotoTriggerHandler`, `truckPhotoAiCheck`, `truckPhotoPipeline`,
`truckPhotoPipelineVideos`, `truckPhotoVideoLinks`, `truckPhotoPdf` and
`truckPhotoPdfVideos` (real pdf-lib and sharp), `truckPhotoSweep`,
`truckPhotoHandlers`, `truckPhotoSettingsRoute`, `truckPhotoStorePg` and
`truckPhotoVideosPg` (require `TEST_DATABASE_URL`) and
`admin/src/pages/settings/TruckPhotosTab.test.jsx`.
