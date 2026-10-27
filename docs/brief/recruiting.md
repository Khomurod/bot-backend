<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list. -->

# §4c. Recruiting and leads

Everything from a Facebook lead arriving to a recruiter's KPI score: the webhook
chain, which recruiter's number texts a candidate and which message they send,
what Wenze may say to a candidate on its own, and the Customer Inquiries desk.

Split out of §4 when that document ran out of room under the 500-line limit —
the same treatment home time got, and for the same reason.

- **Facebook/Meta leads**: Meta → `POST /webhook` (raw-body proxy, Node) →
  Python worker verifies `X-Hub-Signature-256` → posts verified events back to
  `/api/internal/facebook/webhook-events` (shared secret) →
  `facebookWebhookService.js` queues and dedupes (`facebook_webhook_events`,
  key `leadgen:<pageId>:<leadgen_id>`) → `facebookLeadEventProcessor.js`
  fetches the lead via Graph → formats → posts to the leads Telegram group →
  creates a Bitrix24 CRM lead (best-effort; CRM failure never blocks the
  Telegram post) → fires auto-SMS **from the assigned recruiter's number** →
  mirrors SMS replies two-way.
- **A lead event is tried at most five times, then abandoned** — retries wait
  1, 5, 15 and 60 minutes, so a short outage is ridden out. The fifth failure
  marks the event `abandoned` (never claimed again) and posts ONE notice to the
  leads group; Retry on the admin Facebook Leads page restores a fresh budget.
  Until October 2026 there was no end: a May test lead had 9,041 attempts.
- **A retry never repeats what already happened.** The Telegram post is
  stamped in `facebook_webhook_events.telegram_posted_at` and skipped once
  stamped; the Bitrix record is reused once the `leads` row carries its id; the
  SMS is skipped once `sms_from_number` is set. Before this, each retry of an
  event that failed after the post put the lead in the group again.
  `tests/facebookWebhookRetryLimit.test.js`, `tests/facebookWebhookQueuePg.test.js`.
- **An inbound SMS forwarded to Telegram registers its own reply mirror**
  (`leads-bot/webhook/connect_command.py` `_register_inbound_sms_mirror`), and a
  recruiter's reply to the forward goes back as SMS through it. Until October
  2026 that function named `TELEGRAM_CHAT_ID` without importing it. The
  NameError was swallowed as a warning, no mirror was ever registered, and every
  such reply failed with "No auto-SMS mirror found". Every other test patched
  the function away; `test_rc_forward.TestInboundSmsMirrorRegistration` runs
  its real body.
- **The lead's text comes from whoever Bitrix24 assigned it to.** Bitrix assigns
  asynchronously, so `facebookLeadSmsSender.js` re-reads `crm.lead.get` on a
  bounded poll (the *assignee wait* setting, default 25s at 5s intervals) —
  **and follows a lead into the deal it was converted into**, because in this
  Simple-CRM portal the round-robin that picks a recruiter fires on the DEAL
  while the lead keeps the webhook owner forever (see
  `docs/architecture/recruiter-sms-sender.md`),
  matches `ASSIGNED_BY_ID` to `recruiters.bitrix_user_id`, and sends with that
  recruiter's own RingCentral credentials. **RingCentral refuses an SMS whose
  `from` is another extension's number** — no token, super-admin included, can
  send on someone's behalf — which is why per-recruiter credentials exist at
  all. It also refuses one that is not **E.164**, and recruiter numbers are
  stored as an admin typed them, so every send goes through
  `lib/phone/e164.js`; a rejection is then checked against what that extension
  really owns instead of being reported as an opaque `MSG-245`. Any gap (nobody
  mapped, no assignee yet, unmapped assignee, broken credentials, an unusable
  stored number, a number not on the extension or not SMS-capable, a rejected
  send) falls back to the shared number `RC_FROM_NUMBER`; **a lead is never left
  un-texted**, every fallback an operator could fix is stated in the Telegram
  thread, and the reason is stored on the mirror row (`fallback_reason`) so it
  can be queried rather than only read.
- **The assigned recruiter chooses the WORDS too, when they have written any.**
  Facebook Leads → Auto-Reply Setup has a **Recruiter messages** section listing
  every active recruiter (Sofia, Kimberly, Jaime, and anyone added later — it is
  driven by the `recruiters` table, not a list in code). One optional template
  each, deliberately not a second scheduling engine: when the assigned recruiter
  has a non-blank one it is used, otherwise the existing global time-window
  rules and the outside-hours fallback decide exactly as before. `{rep_name}`
  renders as the recruiter who is actually texting, falling back to the settings
  rep name when the lead goes out on the shared number. The Bitrix assignee is
  therefore resolved BEFORE the template is picked — one bounded poll per lead,
  not two — and the same resolution is what sends. A blank template deletes the
  row, so "no custom message" has exactly one representation, and a database
  failure reading it silently falls back rather than costing a lead its text.
  `facebook_lead_recruiter_messages`, guarded by
  `tests/facebookLeadRecruiterMessages.test.js`,
  `tests/facebookLeadRecruiterFlow.test.js` and
  `tests/facebookLeadRecruiterMessagesPg.test.js`.
- **A lead that has already been texted is never texted again.**
  `leads.sms_from_number` is the record of it, checked before every send, which
  closes the admin retry button and the at-least-once crash window alike — and
  makes every lead processed before per-recruiter sending immune to a resend.
- **The Bitrix mapping can be done from the panel, not by hand.** Settings →
  RingCentral → Bitrix24 → **Match recruiters to Bitrix users** reads the
  portal's user directory (`user.get`, so the inbound webhook needs the `user`
  scope) and maps recruiters to Bitrix users by phone or full name. It applies
  only strong, unambiguous matches; a first-name-only guess is proposed for
  confirmation, an existing mapping is never overwritten, and previewing is a
  separate call from applying. Details and the refusal rules:
  `docs/architecture/recruiter-sms-bitrix.md`.
- **Recruiters attach their own number themselves.** An admin mints a link
  (Settings → RingCentral, or `POST /api/recruiters/connect-link`); the
  recruiter opens `/ringcentral/connect/:token`, signs in to RingCentral, and
  the app stores an OAuth refresh token plus the extension identity it read
  back. No secret changes hands, and the sending number cannot be typed wrong.
  The older path — an admin pasting that recruiter's JWT — still works and is
  used when there is no login.
- **Wenze is taught what it may tell a candidate, and confirms it first.**
  Facebook Leads → **Teach Wenze**: an administrator types a sentence in
  ordinary language ("company driver pay is 77 cents per mile"), Wenze restates
  what it believes should change, and **nothing is in use until they agree**.
  Three kinds — a `fact` it may say, a `boundary` it must never say, a
  `correction` that overrides both. Nothing is ever overwritten: a changed rate
  produces a new row that supersedes the old one, which stays with the dates it
  was true, because "what were we telling candidates in August" gets asked after
  a dispute. `recruiting_knowledge`, `docs/architecture/recruiting-knowledge.md`.
- **Outside working hours, Wenze continues the conversation as the assigned
  recruiter.** A lead that arrives at 9pm on a Friday is answered by the
  candidate within minutes and then hears nothing until Monday. Wenze now
  replies on the same recruiter's number, through the same `sendSmsAsRecruiter`
  — **but only from what has been approved above**, and only when an
  administrator has switched it on. With nothing approved it answers nothing.
  A draft naming a figure no approved statement contains, or promising,
  guaranteeing, approving, waiving, hiring or setting a start date, is
  **refused whole** rather than edited; the candidate then gets one fixed line
  saying a recruiter will follow up, and a human is told which conversation
  needs them. Capped (four replies by default), silent in quiet hours (21:00–08:00),
  and stood down the moment a recruiter replies. Every reply is posted into the
  recruiter's Telegram thread marked as Wenze's, so they read what went out in
  their name before answering on top of it. **No employment decision, ever.**
  Configured at Facebook Leads → Teach Wenze; `recruiting_hours_settings`,
  `recruiting_ai_conversations`, `docs/architecture/recruiting-after-hours.md`.
- **A recruiter's own typed reply is now recorded**, as `outbound_recruiter` on
  the mirror ledger. It used to be sent and forgotten, so the database held the
  opening line and the candidate's answers and nothing in between — anybody
  reading that thread back was reading half a conversation and could not tell.
- **Facebook learns which leads become drivers.** Every 15 minutes
  `services/metaCrm/stageSync.js` reads the hiring-pipeline (0) deals Bitrix
  changed in the last seven days and reports each Facebook lead's stage to
  Meta's Conversions API for CRM, keyed by the leadgen id (the `leads` row's
  `external_id`, found through the deal's `LEAD_ID`). The owner's mapping,
  27 October 2026: Interested, Documents, Talking to Dispatch and Sent to
  Safety → `Qualified`; Hired → `Converted`; Lost → `Lost`. New Lead, Contacting
  and "Lost – Qualified (call back later)" send **nothing** — and a stage added
  in Bitrix later sends nothing until somebody maps it. Once per lead per event
  (`meta_crm_events`); no name, phone or e-mail leaves; Bitrix is only read.
  Meta refuses events older than seven days, so a move older than that is not
  reported at all. **The owner enters, tests and saves the dataset ID and
  token in Settings → Facebook ↔ Bitrix** (`meta_crm_settings`, token
  encrypted; `META_CRM_DATASET_ID` / `META_CRM_CAPI_TOKEN` are only the
  fallback for a value never saved there). Test checks the token (`/me`) and
  that it can see the dataset (Dataset Quality API — Meta's "unknown ID / no
  events in 48 h" answer is a warning that still saves), sends one TEST event
  only when given an Events Manager test code and only as an exact copy of a
  Qualified Meta already received in the last 47 h (a test code does NOT keep
  an event out of ads; Meta refuses made-up leads), checks Bitrix's six stage
  ids and dry-runs a pass; Save unlocks only after a Test of the same values
  with no failure, and the server proves the token again by the same rule. Idle
  (`blocked`) while switched off there or while either value is missing
  everywhere. `docs/architecture/meta-crm-settings.md`. Guarded by
  `tests/metaCrmStageEvents.test.js`, `tests/metaCrmStageSync.test.js`,
  `tests/metaCrmEventsPg.test.js` and the `tests/metaCrmSettings*` suites.
- **Self-serve Page connect**: `/connect` in a leads group starts a
  session-token-gated OAuth flow; Page tokens are encrypted
  (`lib/security/facebookCrypto.js`).
- **Indeed leads** arrive from a Gmail Apps Script
  (`docs/gmail-indeed-apps-script.gs`) to `/api/internal/indeed/lead`.
- **Recruiter KPIs**: RingCentral call logs sync into `ringcentral_calls`. The
  targets are configurable defaults (`ringcentral_settings`): 2h30m of real talk
  time per day, 150 outbound calls/day, and calls shorter than 30s do not count
  as valuable. The score weights talk time 70% / outbound 30%. Public leaderboard
  at `/recruiters` exposes names and KPI numbers only — **never phone numbers**.
  Its totals are computed in SQL, and the answer is kept in the process until a
  call is written, a recruiter or the KPI settings change, or five minutes
  pass. A screen left polling costs the database nothing in between
  (`docs/brief/database-transfer.md`).

## Safety Approvals (the recruiting group)

- **The bot posts Safety's hire decisions**, one driver at a time, in the
  group's "approved / not approved" topic: **the driver's post as the
  recruiter sent it** (the CDL photos and the recruiter's words) with
  "✅ APPROVED by Aubrey" / "❌ NOT APPROVED by …" and Safety's reason under it.
  Safety's PSP / MVR / CLH files are not re-posted. A hashtag goes out about
  five seconds after it is written. A post Safety forwarded counts as the
  original recruiter's.
- **Safety marks a decision `#Approved` / `#NotApproved`** as a reply to the
  driver's post (the team's convention since 20 October 2026). A hashtag
  decides with **no model**; the driver is read off the post. The words alone
  ("approved", "not approved", "can / can't hire") still count and are read by a model, verified by
  `lib/safetyApprovals/reading.js`. Other Safety messages ("on it", "CLH sent")
  cost nothing. Only people ticked as Safety decide.
- **Nothing is lost, nothing is guessed.** A decision not written as a reply is
  matched to the posts the last six messages were about (a model may only pick
  one by label). A team hashtag naming nobody, or a decision the bot cannot
  place, makes the bot **ask Safety in General** under their message.
- Off by default; Settings → Safety Approvals cannot switch it on without a
  validated group, a topic and a Safety person. The group is moved from
  `driver` to `recruitment` so no driver feature acts on it. Captured messages
  are deleted after 60 days. See
  [`docs/architecture/safety-approvals.md`](../architecture/safety-approvals.md).

## Bitrix stage proposals (the recruiting group's General topic)

- **The bot follows each candidate's conversation in General** ("CLH sent",
  "CLEAN", "Approved") and, when it shows the candidate has reached a later
  stage of the Bitrix deal pipeline, **replies there with "move <driver> to
  <stage>?" and a Move / No button**. Anyone in the group may press it; only
  then does the deal move (`crm.deal.update`), after it is read again — a deal
  moved by hand meanwhile is not moved. The owner's request, 20 October 2026.
- The deal is found by the phone a recruiter typed, else by first AND last
  name; two different people matching proposes nothing. With no deal, the
  recruiter who posted the candidate is asked once to create it, with a
  "search again" button.
- A model picks the stage by meaning; `lib/hiringStages/proposal.js` keeps only
  a stage of that pipeline, forward of where the deal is (or a lost stage),
  quoting words somebody wrote. SSNs, birth dates, licence numbers and phones
  are removed before the text is sent; no photo is.
- Off by default (Settings → Safety Approvals → 5, needs Safety Approvals on).
  Proposals are deleted after 60 days. See
  [`docs/architecture/hiring-stage-proposals.md`](../architecture/hiring-stage-proposals.md).
