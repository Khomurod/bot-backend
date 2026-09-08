# How Bitrix decides whose number texts a lead

The companion to [`recruiter-sms-sender.md`](recruiter-sms-sender.md), which
covers the sending half — the credential, the E.164 `from`, the fallback and the
reply. This one covers the half BEFORE that: how a Bitrix assignment becomes a
recruiter row, where the connection is configured, and the two Bitrix-side traps
that were live and silent.

`recruiters.bitrix_user_id` is the only link from a Bitrix lead assignment back
to a recruiter, so it is what decides whose number a driver hears from. No id
means no match, which means the shared number.

## Where Bitrix is configured

In the app. Settings → RingCentral → Bitrix24 → **Bitrix24 connection** writes
`bitrix_settings` (`database/bitrix.js`, migration 0009): enabled, the inbound
webhook (encrypted at rest), entity, the assignee at creation, source id and
description, deal pipeline, and the assignee wait. **A saved value wins over
the matching `BITRIX24_*` environment variable; a value never saved inherits
it** — so an env-only deployment behaves exactly as before until someone
saves. Every Bitrix caller reads the effective config at call time through
`bitrix24Service` (`isBitrixConfigured`, `getWebhookBase`,
`getBitrixMapperConfig` — all async), never from a module-scope constant.

Two rules that are easy to get wrong:

- **The assignee field refuses a name.** The production value was
  `Tom Robinson`, which Bitrix ignores, so every lead landed on the webhook
  owner while the config looked effective. The form, the route and
  `database/bitrix.js` all reject anything that is not a positive integer (a
  pasted profile URL is cleaned to its number). Blank means "let a Bitrix
  distribution rule assign", and — because `assigned_by_id` is TEXT — a blank
  saved in the panel is `''`, which beats the env name, rather than NULL, which
  would inherit it. **An ignored value inherited from the environment is shown
  in red under the field but never pre-filled into it** — the first day in
  production it was, Save refused it, and the operator saw a button that did
  nothing. Every refused save prints its reason directly under the button;
  the tab banner alone is off-screen from where the click happened.
- **The URL is the credential.** It is never returned to a browser — the admin
  view carries `webhookHost` and `webhookSet` only, and not even a masked tail,
  since the tail is part of the token.

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
