# Who texts a Facebook lead

**The rule:** whoever Bitrix24 assigned the lead to is the person the driver
hears from. Their number sends the text, their phone gets the reply.

Before this, every lead was texted from one shared number — `(470) 480-4679` —
whoever actually owned the lead. A driver who replied reached a line nobody was
watching for them, and the recruiter had to be told second-hand.

## The one constraint that shapes everything

**RingCentral will not send an SMS whose `from` is not a number on the token's
own extension.** Not with an admin token, not with a super-admin token, not with
a JWT. There is no "send on behalf of" for SMS.

So texting as a particular recruiter requires a credential belonging to *that
recruiter*. That is the whole reason per-recruiter credentials exist here, and
the reason a rejected send is never "fixed" by falling back to the shared
*token* — the fallback is the shared **number**, sent with the shared token that
owns it.

### …and its other half: `from` must be E.164

The same constraint has a second edge, and it is the one that was missed.
`recruiters.phone_number` holds **whatever an admin typed** — `(470) 480-4679`,
`4702400064`, `470-419-4110` — and the sender handed that string to RingCentral
verbatim. RingCentral answered:

```
InvalidParameter / MSG-245
Parameter [from] value [(470) 480-4679] is invalid
[Cannot find the phone number which belongs to user]
```

which reads like an authentication failure and is not one. The token was right;
the number was merely unrecognizable. Every lead fell back to the shared number
while the recruiter's credentials worked perfectly — call-log sync never touches
`phone_number`, so KPI attribution stayed healthy the whole time and hid it.

**`lib/phone/e164.js` is now the only answer to "what number do we send?"** It
holds two functions that must never be confused, which is why they sit together:

| | For | Returns |
|---|---|---|
| `toE164(v)` | a number you can SEND from or to | `+14704804679`, or `''` when the value cannot be one |
| `phoneKey(v)` | COMPARING two spellings | the last ten digits, `''` if shorter |

Handing a `phoneKey` to RingCentral fails exactly like the raw column did.
`toE164` returning `''` is deliberate: a caller must fall back to a number that
works rather than send a half-normalized string that the provider will reject.

**A rejection is now checked, not guessed at.** When RingCentral refuses a
`from`, the sender asks `getExtensionInfoWithToken` what that extension actually
owns and turns MSG-245 into a state an operator can act on:

- the same line spelled differently (a stray country code) → **retried once**
  with RingCentral's own spelling, reported as `correctedFrom`;
- not on the extension → `recruiter_number_not_on_extension`;
- there but not SMS-capable → `recruiter_number_not_sms_capable`
  (usually A2P/10DLC registration).

This costs nothing on the happy path — it only runs after a rejection.
`database/ringcentral/recruiters.js` keeps its own lenient `normalizePhone`
**on purpose**: it writes `phone_number_normalized`, which is
`TEXT NOT NULL UNIQUE`, and collapsing short values to `''` there would collide.

The operator's typed value is never rewritten. Diagnose reports the mismatch
instead (`server/routes/recruiter/senderNumberDiagnosis.js`), which is also
where the old false green lived: it compared last-ten digits, so a stored
`(470) 480-4679` against RingCentral's `+14704804679` read **"Number match:
OK"** while every send was rejected.

## The path a lead takes

```
Meta → /webhook (raw-body proxy) → Python verifies the signature
     → /api/internal/facebook/webhook-events → facebook_webhook_events queue
     → facebookLeadEventProcessor.js
         1. post to the leads Telegram group        (never skipped)
         2. crm.lead.add → bitrixId                 (best-effort)
         3. leads row                               (best-effort)
         4. facebookLeadSmsSender.js  ── who sends? ──┐
         5. mirror + "AutoMessage sent" notice        │
                                                      ▼
   hasMappedSmsSenders()  no  → shared number, no Bitrix call, no delay
             │ yes
   waitForCrmAssignee()   ── crm.lead.get, up to BITRIX24_ASSIGNEE_WAIT_MS
             │              (default 25s, polled every 5s; stops as soon as the
             │               answer is usable, so an already-assigned lead
             │               costs one request and no wait)
   ASSIGNED_BY_ID → recruiters.bitrix_user_id → recruiterCanSendSms()?
             │ yes                        │ no / none / broken
             ▼                            ▼
   sendSmsAsRecruiter()            sendSms()  + a fallbackNote in Telegram
```

**Why the poll exists:** `crm.lead.add` returns an id, not an owner. A Bitrix
distribution rule (queue, round-robin) assigns the record moments later, so the
value at creation time is the webhook owner, not the assignee.

**What the poll costs.** The queue drains claimed events one at a time, so the
wait is per lead: a burst of N unassigned leads can delay the last one by up to
N × `BITRIX24_ASSIGNEE_WAIT_MS`. Three things keep that from mattering in
practice, and it is worth knowing which:

- with no recruiter mapped, `hasMappedSmsSenders()` short-circuits and there is
  **no** Bitrix call and no delay — the pre-feature behaviour, exactly;
- a lead Bitrix has already assigned to a mapped recruiter costs **one request
  and no wait**, because the poll stops at the first usable answer;
- only the degraded case — configured, but Bitrix slow or not assigning — pays
  the full budget on every lead.

If that ever bites (a backlog draining after an outage, say), lower
`BITRIX24_ASSIGNEE_WAIT_MS`; `0` means "one read, then send". Nothing is lost
either way: events are persisted before processing, so a slow drain is late,
never dropped.

## A converted lead: the recruiter is on the DEAL

This portal runs **Simple CRM**, so the team never works classic Leads. What
actually happens to a Facebook lead is:

```
crm.lead.add            → lead 1051, owner 1 (the inbound webhook's owner)
   │  a Bitrix automation converts it
   ▼
Contact 1961 (phone, email)  +  Deal 4219  (category 0, stage NEW, LEAD_ID=1051)
                                    │  the round-robin rule on stage NEW fires
                                    ▼
                             owner 137 — a real recruiter
```

The lead is left `STATUS_ID = CONVERTED` and **keeps owner 1 forever**. So
reading only `crm.lead.get → ASSIGNED_BY_ID` finds the webhook owner, who maps
to no recruiter, and every driver is texted from the shared number — which is
exactly what happened for the first 69 leads.

`waitForCrmAssignee` therefore follows the conversion: when the record's own
owner is not someone who can send, it asks
`crm.deal.list?filter[LEAD_ID]=<lead>` (newest first) and uses that assignee,
reporting `via: 'converted_deal'`.

Three properties worth keeping:

- **It is asked only when the cheap answer was unusable**, so a record already
  assigned to a mapped recruiter still costs one read and no delay.
- **It is re-checked on every pass**, because the conversion and the round-robin
  are asynchronous — that is the same reason the poll exists at all.
- **A failure is swallowed**, leaving the record's own assignee in play: this is
  an enrichment, never a new way to lose a text.

Creating deals directly instead was the obvious-looking alternative and is
worse: a deal has no `PHONE` field, so the driver's number — which the
conversion puts on the Contact — would be dropped, and the recruiter could not
call them.

## Two things that must not happen twice

**The notice goes to the group id AS STORED.** `sendAutoMessageSentNotice` used
to run the chat id through `toSupergroupStyleChatId()` unconditionally, turning a
plain group's `-5231255301` into `-1005231255301` — a chat that does not exist.
Telegram answered `400: Bad Request: chat not found`, `telegramHtml` classifies
that as permanent, and the throw landed **before** the `insertFacebookLeadSmsMirror`
call below it. So every lead lost its notice *and* its `outbound_auto` mirror
row, and with no mirror there is no reply anchor: a recruiter's Telegram reply
had nothing to thread onto. The lead post a few steps earlier had always used the
same id verbatim and always worked. `sendToChatIdWithFallback` now tries the
stored id and converts only on a retryable answer — the pattern `sendLeadsMessage`
already used.

**A lead that has been texted is never texted again.** `leads.sms_from_number` is
written only after a send actually left RingCentral, so it is the record of "this
person has heard from us". `sendAutoSms` checks it, which closes every re-drive
at once: the admin retry button (which has no `status <> 'completed'` guard), the
at-least-once window where a process dies after the send and before
`completeFacebookWebhookEvent`, and anything added later. Every lead processed
before per-recruiter sending carries the shared number there, so they are all
structurally immune to being re-texted. A failed lookup opens the guard — "cannot
prove it was sent" must not become "do not send".

## Two guarantees

1. **A lead is never left un-texted.** Nobody mapped, no assignee yet, an
   unmapped assignee, expired credentials, a rejected send, a database hiccup —
   all fall back to `RC_FROM_NUMBER`. Sender resolution never throws: by the
   time it runs the lead is already in Telegram and in the CRM, and an
   exception would cost the driver their text and re-run the whole event.
2. **A fallback an operator could fix is never silent.** An expired RingCentral
   login looks exactly like success from the outside, so every actionable
   fallback returns a `fallbackNote` that the lead's Telegram thread prints
   (`⚠️ Jane Doe could not authenticate with RingCentral …`). Routine states —
   nobody mapped yet, no CRM record — stay quiet.

## Credentials: two shapes, one resolver

`resolveRecruiterRcAuth()` picks `oauth` > `jwt` > `none`.

| Mode | Where it comes from | Notes |
|---|---|---|
| `oauth` | The recruiter opens `/ringcentral/connect/:token` and signs in. Preferred: no secret changes hands and the number is read from RingCentral, not typed. | **The refresh token expires in 7 days and rotates on every use.** `ringCentralTokenRefreshService` renews every stored login daily so a recruiter who goes a week without a lead does not expire from disuse. A dead grant sets `rc_auth_error`, which the admin panel shows as *Needs RingCentral sign-in*. |
| `jwt` | An admin pastes that recruiter's JWT in Settings → RingCentral. The original path, still supported. | Does not expire, so nothing to renew. |
| `none` | — | Their leads are covered by the shared number. |

`services/ringCentralOAuthService.js` is the only place either shape becomes a
bearer token. The same tokens also drive the per-extension call-log read, so
onboarding by signing in never costs a recruiter their KPI attribution.

**Two rules that a rotating credential forces, and both were bugs first:**

- **One grant at a time per recruiter.** A refresh returns a new refresh token
  and invalidates the one used, so two callers refreshing at once means the
  second presents a spent token, gets `invalid_grant`, and a perfectly healthy
  recruiter is flagged as needing to sign in again. The call-log sync and the
  daily refresh job both start at boot, so this is a real race, not a
  theoretical one. Concurrent callers await the same in-flight grant.
- **The access-token cache is keyed by recruiter, so a new login must
  invalidate it.** Keying by the credential looks tidier and is wrong: callers
  pass a `recruiters` row they loaded earlier, so after a rotation their row's
  token is stale and a credential-keyed cache would miss and send that spent
  token back. The cost of id-keying is explicit invalidation on a genuine
  re-authorization — otherwise a recruiter who reconnects to fix a
  wrong-account sign-in keeps sending with the old account's token until it
  expires. Both writers of a new login call `clearRecruiterTokenCache()`: the
  connect flow and the admin "forget sign-in" route.

## Replies come back on the same number

`facebook_lead_sms_mirrors.recruiter_id` / `.from_number` record which of our
numbers a conversation is on:

- **outbound** — set when the "AutoMessage sent" notice is posted;
- **inbound** — the Python forwarder passes `to[0].phoneNumber` (the number the
  driver texted) and the hub matches it to its recruiter.

A reply typed in Telegram then goes out from that number. A mirror with no
sender — every row written before this feature, and every lead that fell back —
uses the shared number exactly as before.

For an inbound SMS to a recruiter's number to reach Telegram at all, the
subscription must watch that extension: `leads-bot/sms.py → inbound_sms_filters()`
adds one `message-store/instant` filter per extension, read from
`GET /api/internal/ringcentral/sms-extensions`. Watching another extension needs
an **account-admin** subscriber.

**`rc_extension_id` used to be NULL for anyone who did not sign in.** It was
written by exactly one code path — the OAuth callback — so a recruiter onboarded
by an admin pasting their JWT had none. They sent leads from their own number
perfectly well, `listRecruitersWithOwnCredentials()` included them, and then
`.filter(Boolean)` dropped them from the roster: the driver got a text from a
line nothing was watching. `services/recruiterExtensionIdentity.js` fills it in
from RingCentral itself, driven by `ringCentralTokenRefreshService` — which
already walks every credentialed recruiter, and runs **once at boot**, so a
deploy repairs production in minutes rather than a day. The internal route now
warns by name about anyone still missing one instead of dropping them silently.

**A refused filter set sheds one extension at a time.** It used to go straight
from "everyone" to "nobody": one unusable extension id produced
`CMN-101 Parameter [eventFilters] value is invalid` and the retry dropped
**every** recruiter's filter. Now `valid_extension_ids()` refuses a non-numeric
id locally (naming it, rather than letting it invalidate the whole payload), and
the ladder gives up capability in the order that costs least — MMS first, then
recruiters one at a time, then the shared extension alone. The filters
themselves are logged; they carry no secret, and without them a bad id was
invisible. The warning also stopped claiming "WITHOUT per-recruiter extensions"
when the roster was empty and the real loss was MMS.

`hub_client._fetch_ringcentral_sms_extensions` now **raises** when the shared
secret is unset instead of returning `[]`. Returning an empty list made a
misconfigured deployment indistinguishable from a company with no recruiters
onboarded — and `reconcile_rc_subscription` would re-register with no extensions
rather than leaving the working subscription alone.

**The subscription is reconciled, not registered once**
(`leads-bot/webhook/rc_subscription.py`). A recruiter can finish onboarding at
any time, and registering only at startup would leave their replies reaching
nobody until the Python worker restarted. Every 15 minutes the roster is
re-read and the subscription is re-registered **only if the set changed**, so
the steady state costs one internal request and nothing else. Two rules there
matter more than they look:

- a **failed** read is not an empty roster. After the first pass a failure skips
  the tick and leaves the working subscription alone — re-registering with no
  extensions because the hub was briefly unreachable would silently drop every
  recruiter's inbound SMS;
- the **first** pass registers regardless, even with an empty roster, because
  the shared company number must be watched from boot.

## Operational prerequisites (not code)

These are done in the RingCentral and Bitrix consoles. Until they are, the
feature degrades to the old behaviour rather than breaking.

1. **Register every recruiter's number for A2P/10DLC** in the RingCentral admin
   portal (TCR campaign). An unregistered number's sends are rejected — the
   lead still gets its text from the shared number, and the failure shows up as
   a `recruiter_send_failed` note.
2. **Enable the Authorization Code grant** on the RingCentral app and register
   the redirect URI **exactly**:
   `https://<RENDER_EXTERNAL_URL>/ringcentral/oauth/callback`. It must match
   byte-for-byte, which is why it is derived from `config.publicBaseUrl` in one
   place (`buildRedirectUri`). The app needs `SMS` and `ReadAccounts`.
3. **Map each recruiter to their Bitrix24 user.** Settings → RingCentral →
   Bitrix24 card → **Match recruiters to Bitrix users** reads the portal's user
   directory and proposes the mapping; the row's **Pick from Bitrix** dropdown
   and the plain number field are both still there for anything it could not
   decide. No id means no match, which means the shared number. See
   *Mapping recruiters to Bitrix users* below for what it will and will not
   decide on its own — and note it needs the **`user` scope** on the inbound
   webhook, which a CRM-only webhook does not have.
4. **Confirm the Bitrix rule actually assigns new leads**, and roughly how
   fast. If assignment regularly takes longer than the *wait for a distribution
   rule* setting (Settings → RingCentral → Bitrix24; env fallback
   `BITRIX24_ASSIGNEE_WAIT_MS`), raise it — or move to a Bitrix outgoing webhook
   (`ONCRMLEADUPDATE`) instead of polling. Polling was chosen because it needs
   no new public endpoint and no Bitrix-side configuration.

## Where Bitrix is configured, and how recruiters map to it

Both moved to [`recruiter-sms-bitrix.md`](recruiter-sms-bitrix.md) — the
Bitrix connection settings, the automap tiers and why it refuses more than it
accepts, and the two Bitrix-side traps (an assignee field that silently
ignores a name, and form answers with nowhere to go). This document stays
about the sending half.

## Verifying it without a real lead

- **Settings → RingCentral → Bitrix24 card → Diagnose** — the CRM half of the
  chain, in the order the lead flow depends on it: configuration → portal
  reachable and `crm`-scoped → the configured status exists → the form's
  questions can be stored → **every** active recruiter is mapped and able to
  send → **the assignee readback on the most recent real lead** → what happened
  to leads in the last 14 days. Read-only; it creates nothing. The webhook URL
  is never returned, only its host — a Bitrix inbound webhook authenticates by
  its path, so the URL *is* the credential.

  Two things it checks that are easy to get wrong by only looking at the base
  configuration:

  - **every effective field map**, not just the base one. The mapper resolves
    its map with the incoming form id, and `byFormId` /
    `BITRIX24_FIELD_MAP_BY_FORM_ID` can override the status and the custom
    rules per form — so a form override pointing at a status the portal lacks
    would otherwise hide behind a green base map;
  - **every** active recruiter, not merely one. An active recruiter can be
    assigned a lead, so one who cannot text it is a real gap. A recruiter who
    should not receive leads belongs deactivated.
- **Settings → RingCentral → a recruiter's row → Diagnose** — credentials →
  auth → number match → **SMS capability** → call-log read. The SMS-capability
  step is the one that predicts a rejected send.
- **Send test SMS** on the same row sends a real text from that recruiter's
  number to a number you type. There is no default recipient, so it cannot text
  a driver by accident.

## Tests that guard this

| Area | Test |
|---|---|
| Bitrix assignee read + bounded poll | `tests/bitrixAssignee.test.js` |
| Sender choice and every fallback | `tests/facebookLeadSmsSender.test.js` |
| `from` is E.164 whatever the row says, and a rejection is checked against the extension | `tests/ringCentralSmsSender.test.js` |
| `toE164` / `phoneKey` over every production spelling | `tests/phoneE164.test.js` |
| Diagnose predicting a real send, not a last-ten match | `tests/senderNumberDiagnosis.test.js` |
| The notice using the stored chat id, and the mirror it writes | `tests/facebookLeadSmsReply.test.js` |
| A lead already texted is not texted again | `tests/facebookLeadEventProcessor.test.js` |
| The extension identity backfill | `tests/ringCentralTokenRefresh.test.js` |
| `fallback_reason` on the mirror, on real PostgreSQL | `tests/smsMirrorFallbackReasonPg.test.js` |
| The subscription payload, and shedding one extension at a time (Python) | `leads-bot/test_rc_webhook_register.py` |
| Token exchange, rotation, expiry flagging | `tests/ringCentralOAuthService.test.js` |
| The connect link, and the wrong-extension warning | `tests/ringCentralConnectService.test.js` |
| The daily refresh job | `tests/ringCentralTokenRefresh.test.js` |
| Credential precedence, `canSendSms`, masking | `tests/recruiterSenderIdentity.test.js` |
| Replies leaving from the right number | `tests/facebookLeadSmsReply.test.js` |
| The whole lead event, in order | `tests/facebookLeadEventProcessor.test.js` |
| Routes: admin, public connect, internal list | `tests/recruiterSenderRoutes.test.js` |
| Migration 0008 on real PostgreSQL | `tests/recruiterSenderIdentityPg.test.js` |
| The Bitrix diagnosis, and that the webhook secret never leaves | `tests/bitrixDiagnostics.test.js`, `tests/bitrixSettingsRoutes.test.js` |
| Answers reaching the CRM, and the inert-assignee warning | `tests/bitrix24LeadMapper.test.js` |
| Inbound recipient extraction, per-extension filters (Python) | `leads-bot/test_rc_forward.py` |
| The subscription keeping up with the roster (Python) | `leads-bot/test_rc_subscription.py` |
