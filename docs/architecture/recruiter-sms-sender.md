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
an **account-admin** subscriber; if RingCentral refuses, registration retries
with the shared extension alone and logs that recruiter replies will not be
mirrored — one number covered beats none.

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
3. **Enter each recruiter's Bitrix24 user ID** (Settings → RingCentral → the
   recruiter's row). Take it from their Bitrix profile URL:
   `/company/personal/user/<id>/`. No id means no match, which means the shared
   number.
4. **Confirm the Bitrix rule actually assigns new leads**, and roughly how
   fast. If assignment regularly takes longer than
   `BITRIX24_ASSIGNEE_WAIT_MS`, raise it — or move to a Bitrix outgoing webhook
   (`ONCRMLEADUPDATE`) instead of polling. Polling was chosen because it needs
   no new public endpoint and no Bitrix-side configuration.

## Verifying it without a real lead

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
| `from` + token always agree | `tests/ringCentralSmsSender.test.js` |
| Token exchange, rotation, expiry flagging | `tests/ringCentralOAuthService.test.js` |
| The connect link, and the wrong-extension warning | `tests/ringCentralConnectService.test.js` |
| The daily refresh job | `tests/ringCentralTokenRefresh.test.js` |
| Credential precedence, `canSendSms`, masking | `tests/recruiterSenderIdentity.test.js` |
| Replies leaving from the right number | `tests/facebookLeadSmsReply.test.js` |
| The whole lead event, in order | `tests/facebookLeadEventProcessor.test.js` |
| Routes: admin, public connect, internal list | `tests/recruiterSenderRoutes.test.js` |
| Migration 0008 on real PostgreSQL | `tests/recruiterSenderIdentityPg.test.js` |
| Inbound recipient extraction, per-extension filters (Python) | `leads-bot/test_rc_forward.py` |
| The subscription keeping up with the roster (Python) | `leads-bot/test_rc_subscription.py` |
