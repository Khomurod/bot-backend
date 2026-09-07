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
3. **Map each recruiter to their Bitrix24 user.** Settings → RingCentral →
   Bitrix24 card → **Match recruiters to Bitrix users** reads the portal's user
   directory and proposes the mapping; the row's **Pick from Bitrix** dropdown
   and the plain number field are both still there for anything it could not
   decide. No id means no match, which means the shared number. See
   *Mapping recruiters to Bitrix users* below for what it will and will not
   decide on its own — and note it needs the **`user` scope** on the inbound
   webhook, which a CRM-only webhook does not have.
4. **Confirm the Bitrix rule actually assigns new leads**, and roughly how
   fast. If assignment regularly takes longer than
   `BITRIX24_ASSIGNEE_WAIT_MS`, raise it — or move to a Bitrix outgoing webhook
   (`ONCRMLEADUPDATE`) instead of polling. Polling was chosen because it needs
   no new public endpoint and no Bitrix-side configuration.

## Mapping recruiters to Bitrix users

`recruiters.bitrix_user_id` is the only link from a Bitrix lead assignment back
to a recruiter row, so it is what decides whose number texts a driver. It used
to be filled in by hand: open the Bitrix profile, read the id out of the URL,
type it into the panel — per recruiter, and again for every new hire.

`services/recruiterBitrixMapping/` does it instead:

| Module | Job |
|---|---|
| `directory.js` | reads `user.get` (paged), normalizes to id / name / phones / active |
| `match.js` | **pure**: decides which Bitrix user is which recruiter |
| `index.js` | preview and apply, and the only place a row is written |

**Why it refuses more than it accepts.** An unmapped recruiter costs a lead the
personal touch — it goes out from the shared number. A *wrongly* mapped one
texts a driver from a colleague's phone and routes the reply to the wrong
person. So the tiers are deliberately asymmetric:

- **phone** — the recruiter's number is on exactly one Bitrix profile. The
  strongest signal available, because it is the same number that will send.
- **name** — the full name matches exactly one profile, in either word order
  (`Alex Smith` / `Smith Alex`), accents and punctuation ignored.
- **first_name** — only a first name to go on. **Proposed, never applied**:
  "Alex" the recruiter and "Alex" in accounting are indistinguishable from
  here, so an operator ticks the box.

Anything matching two or more profiles is `ambiguous`; two recruiters landing
on one profile, or a profile that already belongs to someone else, is a
`conflict`. Neither is written.

**An existing mapping is never overwritten.** A stored id is an operator's
decision. When a strong signal disagrees with it the disagreement is *reported*
as a `mismatch` and the row is left alone.

**Preview and apply are separate calls.** `POST /api/recruiters/bitrix-automap`
previews; only `{ apply: true }` writes, and the panel always previews first.
The partial unique index on `bitrix_user_id` is the backstop — a rejected row
is reported per row and does not abandon the rest of the plan.

**A confirmation names the Bitrix user, not just the recruiter.** `confirm`
takes `{ recruiterId, bitrixUserId }` pairs. Apply re-reads the directory, so a
recruiter id alone would authorize whatever that recruiter resolves to the
*second* time — a different sole first-name match, if the portal changed in
between. A pair that no longer matches the plan is reported in `failed` ("the
directory now matches …, re-run the match") and nothing is written for it.

**Collisions are computed across both tiers.** Counting only the strong matches
left two first-name proposals for one Bitrix user both confirmable, and the
unique index then picked the winner by write order. A strong match beats a weak
claim on the same user — a phone match is not in doubt because someone shares a
first name — so the weak one becomes the conflict and the strong one still
applies; two claims of equal strength are a real ambiguity and neither is
written.

**One profile is one candidate.** Bitrix commonly repeats a number across
`PERSONAL_MOBILE` and `WORK_PHONE`; the phone index is deduplicated by user id,
because `resolveCandidate` reads a key's length to decide ambiguity and one
person listed twice would refuse the strongest match available.

**`GET /api/recruiters/bitrix-users`** backs the per-row picker. It returns
id, name, email, position and active only: phone numbers are matched
server-side and never need to reach a browser to do it. Like every Bitrix
surface here it returns the webhook's **host** and never its path.

**`GET /api/recruiters/bitrix-users/:bitrixId`** is the per-row **Check Bitrix
user** button — "is this id a real person, and who?". `ok:false` means the
lookup could not run (bad id, no `user` scope, unreachable); `ok:true` with
`found:false` means it ran and nobody in the portal has that id. It needs the
same `user` scope as the directory, and doubles as a scope probe. Same fields,
same host-only rule.

**Typing an id is validated, not silently coerced.** A recruiter row's id
field accepts a pasted profile URL (`/company/personal/user/17/`) or a `#17`
and cleans it to the number; anything that is not ultimately a positive integer
is **refused with a message**, because the server's `normalizeBitrixUserId`
turns junk into `null` — and a save that writes `null` clears the mapping while
reporting success, the "it won't save" symptom. The cleaner is
`admin/src/pages/settings/ringcentral/bitrixUserId.js` (pure).

Tests: `tests/recruiterBitrixMatch.test.js` (the tiers and every refusal),
`tests/recruiterBitrixDirectory.test.js` (paging, the missing-`user`-scope
case, and the single-id check — found / not-found / bad-id / no-scope),
`tests/recruiterBitrixMapping.test.js` (preview-writes-nothing, per-row
failure, the check endpoint), and, on the admin side, `bitrixUserId.test.jsx`
(the cleaner), `BitrixAutomapPanel.test.jsx`, `RecruiterCardBitrixPicker.test.jsx`
and `RecruiterCardBitrixCheck.test.jsx` (a bad id is refused rather than saved,
a pasted URL is cleaned, and the check button's answers).

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

## Two Bitrix-side traps

Both were live, both were silent, and both matter more now that the assignee
decides who texts a lead.

- **`BITRIX24_ASSIGNED_BY_ID` must be a numeric user id.** It was set to a
  NAME (`Tom Robinson`), and Bitrix only accepts the id, so the value was
  ignored entirely: every lead was assigned to the inbound webhook's owner. The
  mapper now warns once per process, and the Diagnose card reports it as
  *ignored* rather than leaving a config line that looks effective. Take the id
  from the Bitrix profile URL (`/company/personal/user/<id>/`) — or leave it
  blank, which is the right setting when a distribution rule assigns leads.
- **A form answer with no Bitrix field is written into the lead's COMMENTS.**
  The Facebook form asks the two questions a recruiter screens on ("2 years of
  experience?", "CDL-A over the road?") and the portal has no custom lead
  fields for them, so the mapper had nowhere to put them and dropped them with
  a console warning — the recruiter opened the lead and saw a name and a phone
  number, as if nothing had been answered. Field mapping is still the goal
  (create the fields, then `npm run discover-bitrix-fields`); this makes the
  gap cosmetic instead of lossy. Note the field catalog is cached for the life
  of the process, so a newly created Bitrix field needs a restart.

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
| The Bitrix diagnosis, and that the webhook secret never leaves | `tests/bitrixDiagnostics.test.js`, `tests/bitrixSettingsRoutes.test.js` |
| Answers reaching the CRM, and the inert-assignee warning | `tests/bitrix24LeadMapper.test.js` |
| Inbound recipient extraction, per-extension filters (Python) | `leads-bot/test_rc_forward.py` |
| The subscription keeping up with the roster (Python) | `leads-bot/test_rc_subscription.py` |
