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
