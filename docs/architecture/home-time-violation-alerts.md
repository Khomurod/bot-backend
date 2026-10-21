# Home-time violation alerts — Bitrix pipeline 33 → accounting

When a **company** driver breaks Wenze's home-time policy — home after fewer
than **28 days** on the road, or home for more than **4 days** — accounting is
told in a Telegram group to charge the driver, and marks the outcome with a
button. Owner's request, 21 October 2026.

## The verdict is Bitrix's, never the app's

An external Google Apps Script moves each company driver's card in Bitrix24
pipeline **CATEGORY_ID 33** ("6. HOMETIME MONITORING"). Three of its stages are
violations; nothing else ever produces an alert:

| Stage | Means | Posts |
|---|---|---|
| `C33:UC_HTEARLY` | came home early | "Came home early" |
| `C33:UC_HTREDFLAG` | overstayed (after 28+ days) | "Overstayed" |
| `C33:UC_HTEARLYOVER` | both | whichever has not been posted for this home stay; both in ONE message if neither was |
| `C33:UC_HTAGREED`, `UC_ROADU4W`, `UC_SUPERMAN`, `LOSE` | allowed / on the road / closed | never |

Fields read: `TITLE` (the driver), `UF_CRM_HT_FROM` (home since — half of the
idempotency key), `UF_CRM_HT_LAST_DAYS`, `UF_CRM_HT_ROAD_BEFORE`,
`UF_CRM_HT_ALLOW`, `UF_CRM_HT_UNTIL`. **The app's own home-time state machine
(`services/homeTimeService.js`, `driver_road_history`, the road bonus) is not
read and not changed.**

**Bitrix is checked before it is trusted.** Every pass (and the first webhook
after a restart) asks `crm.deal.fields` and `crm.status.list` (`DEAL_STAGE_33`)
whether those five fields and three stages exist. If any is missing the pass
stops with `blocked: Bitrix pipeline 33 is missing …` on the Systems tab and
posts nothing. A success is remembered for six hours; a failure never.

## Two ways in, one way through

1. **The webhook** — a Bitrix automation robot calls
   `POST /api/integrations/bitrix/home-time-violation?token=…` when a card
   ENTERS a violation stage. The payload is only a hint: the deal id is taken,
   the card is re-read with `crm.deal.get`, and its current stage decides. The
   answer is an immediate `202`; the work happens after it.
2. **The reconciliation pass** — every 30 minutes
   (`home_time_violation_alerts` in the background roster), because Bitrix does
   not retry a failed webhook. It lists every card in the three stages and
   records whatever is new. It also retries sends that failed.

Both go through `processDeal` (`services/homeTime/violationAlerts.js`).

## Exactly once

`home_time_violation_notices` (migration 0079) holds one row per **deal + home
stay (`UF_CRM_HT_FROM`) + violation**, `UNIQUE`, inserted `ON CONFLICT DO
NOTHING`. Only the rows an insert actually created may be posted; a second
writer — the pass racing the webhook, a retried webhook, a restart — gets
nothing back and posts nothing. A message naming both violations is two rows
sharing one `telegram_message_id`. Posting takes a 120-second lease
(`claimForPosting`), so two posters never send the same rows. A failed send is
retried by the next pass; the sixth failure marks the rows `abandoned`.

`tests/homeTimeViolationsPg.test.js` proves the races on PostgreSQL.

## The go-live baseline

Switching the alerts on clears `violation_alerts_baselined_at`. The next pass
records every card ALREADY in a violation stage as `baselined` — **never
posted** — logs how many, and stamps the time. Until it has, the webhook does
nothing (the pass will record the card with the rest). Switching off and on
again re-arms it, so a backlog never reaches the group.

## Missing data

A card in a violation stage with no readable `UF_CRM_HT_FROM` is skipped, never
guessed, and files `home_time.violation_card_incomplete` (warning, one per
deal) on Needs Attention. It resolves itself once a full pass no longer sees
it. Blank day counts are shown as missing, never as zero.

## The message and the buttons

Built by `lib/homeTime/violations.js` (pure, unit-tested): driver, the
violation(s) with their day counts against the policy, home since, and the
accounting mentions (`ACCOUNTING_MENTIONS`). **No dollar amount** — what to
charge is a person's decision. **No truck number** in this version: a Bitrix
deal is matched to a driver only by name, and a guessed truck is worse than
none.

`✅ Charged` / `❌ Not charging` (`htv:c:<id>` / `htv:n:<id>`,
`bot/handlers/homeTimeViolationHandlers.js`):

- **Only accounting** — `isAccountingUser`, the mileage bonus allow-list, which
  now defaults to the two accountants' **Telegram ids** (Cameron 6504395610,
  Ella 8245947790); `MILEAGE_BONUS_ACCOUNTING_USER_IDS` overrides. Anyone else
  gets an alert and nothing changes.
- **Written once** — `decide` updates only rows whose `decision IS NULL`; a
  double tap or a second accountant is told who answered first.
- **Charged** — the message is edited to say who and when; the buttons go.
- **Not charging** — recorded at once (so nobody else can answer), then the
  presser is asked in a force-reply why. Their reply — only theirs, only once —
  is written into the message. Until then it reads "waiting for … to reply".

## Settings

On the **Home Time** page (`admin/src/pages/homeTime/ViolationAlertsCard.jsx`),
stored on `home_time_settings`: `violation_alerts_enabled`,
`violation_alerts_chat_id` (reachability-checked like the other home-time
groups; cleared → switched off; listed in `lib/telegram/chatMigration.js`).
The switch cannot be turned on without a group.

**The webhook secret is created on the same page** (owner's ask, 21 October
2026: no trip to the hosting panel). "Create webhook link"
(`ViolationWebhookLink.jsx` → `POST /api/home-time/settings/violation-webhook-secret`)
makes a random secret (`services/homeTime/violationWebhookSecret.js`), stores it
**encrypted** in `home_time_settings.violation_webhook_secret_encrypted`
(migration 0080; AES-256-GCM, the same key as the Bitrix webhook URL) and
returns it **once**, so the page shows the full link to copy. It is never sent
to the browser again: `publicViolationSettings` strips the column from every
settings response and adds only `violation_webhook_secret_set`. Creating a new
link replaces the old one at once. The webhook reads the secret at most once a
minute. The environment variable `HOME_TIME_VIOLATION_WEBHOOK_SECRET` is only a
fallback while no secret has been created in the app; a secret that no longer
decrypts (the key changed) counts as not set — create a new link.

## Setting up Bitrix (once, by a Bitrix admin)

1. On the Home Time page, in "Home-time violation alerts", press **Create
   webhook link** and copy the link (shown once). Without it every webhook call
   is refused (401) and alerts come only from the 30-minute pass.
2. In Bitrix24: CRM → Deals → pipeline **6. HOMETIME MONITORING** → **Automation
   rules**. On **each** of the three stages `DRIVERS AT HOME - EARLY`,
   `DRIVERS AT HOME - OVERSTAY` and `DRIVERS AT HOME - EARLY & OVERSTAYED`, add
   the robot **Webhook** (Outgoing webhook), triggered when the deal enters the
   stage, with the link from step 1 — it has the form:

   ```
   https://<admin domain>/api/integrations/bitrix/home-time-violation?token=<the secret>&deal_id={=Document:ID}
   ```

   `deal_id` is inserted with the robot's "insert value" button (Deal → ID).
   Nothing else needs to be passed: the card is re-read from Bitrix. The robot's
   own `document_id` is also understood if `deal_id` is left out.
3. On the Home Time page: save the accounting group, then switch the alerts
   on. The first pass (within three minutes of a restart, then every 30)
   baselines; from then on, new violations are posted.

**The secret is in the URL** because a Bitrix robot cannot set a header. The
app never logs it and the route never throws to the error handler (which logs
URLs), but the reverse proxy's access log may record it — if it is ever
exposed, create a new link on the Home Time page and paste it into the three
robots.

## Tests

`tests/homeTimeViolations.test.js` (stages, reading a card, which violations to
post, the message, the buttons, the footer, the secret, the deal id),
`tests/homeTimeViolationAlerts.test.js` (the pass, the baseline, once-only
posting, EARLY → EARLY & OVERSTAYED, the next stay, missing data, retries, the
webhook route), `tests/homeTimeViolationHandlers.test.js` (accounting-only,
write-once, the reason), `tests/homeTimeViolationsPg.test.js` (the races).
