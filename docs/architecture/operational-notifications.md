# Where Wenze's operational notices go

> Read this before adding anything that tells a human something. There is one
> door now, and adding a second one is how the last five got built.

## The failure this replaces

Every feature that needed to reach staff invented its own way:

| Feature | Destination |
|---|---|
| Home time clarifications | `home_time_settings.internal_clarification_group_id` |
| Home time manager notices | `home_time_settings.completed_notify_group_id` |
| Mileage bonus, road bonus, dispatch review, raise results | four columns on `message_group_settings`, each with an env fallback |
| AI provider terms | `ai_policy_watcher_settings.notify_chat_id` |
| Broadcast and question summaries | `MANAGEMENT_GROUP_ID`, read from the environment at module load |
| Employee announcements | `EMPLOYEE_GROUP_ID` |

Six destinations across three tables and the environment. An administrator could
not answer "where do Wenze's alerts go?" without reading the source, and neither
could anyone debugging why a chat had gone quiet.

**It also hid a real outage.** `internal_clarification_group_id` was saved as
`5052301861` when the intended chat was `-5052301861`. Every send failed with
"chat not found". The outbox retried, backed off, gave up, and recorded the
error — and told nobody. 101 staff alerts were lost over several months.

## What exists now

**One default chat, optional per-category overrides.** `lib/notifications/categories.js`
is the catalogue: nine categories, each with a label, what lands there, a
severity, and — the field that decides whether an operator wants it in its own
chat — whether a person normally has to do something about it.

`resolveDestination` is pure and has one rule worth stating: **a cleared
override means "use the default", never "send nowhere"**. The admin form writes
an empty string when a field is emptied, and treating that as a destination is
precisely how a feature goes quiet without anyone noticing.

A category added in code is delivered the day it ships, because an unconfigured
category falls through to the default rather than waiting to be configured.

## The one door

```js
const { notify } = require('services/notifications/send');

await notify({
  category: 'fuel',
  title: 'Unit 310 may not reach its fuel stop',
  lines: ['Range about 120 mi, stop 180 mi ahead'],
  action: 'Reassign or call the driver',
  subjectType: 'group', subjectId: group.id,
  discriminator: `stop-${alert.id}`,   // what makes THIS event different
  evidence: { milesToStop: 180, rangeMiles: 120 },
});
```

Three promises, each of which is a bug this repository has shipped:

- **It is written down before it is sent.** A notice that cannot go out right now
  is a pending row, not a lost event.
- **It is said once.** `notice_key UNIQUE` plus `ON CONFLICT DO NOTHING`. A
  background check re-derives the same condition every few minutes and Render
  restarts this process several times a day, so the guarantee cannot live in
  memory. `notify` returns `{reason: 'already_sent'}` — **that is the guarantee
  working, not a failure**, and a caller that retries on it will double-send.
- **A send failure never breaks its caller.** Detecting a problem and telling
  somebody about it are different jobs. Nothing here throws.

`discriminator` is what makes an event distinct from the same condition seen
again. A cycle id, a load id, a date. Get it wrong in one direction and a driver
is mentioned every twelve minutes; wrong in the other and a genuinely new event
is swallowed.

## What a notice may never say

`lib/notifications/compose.js` sanitises **every** part of the body, not only the
free-text reason, because a notice lives in a group chat's history forever:

- a signed or expiring URL (Samsara media links look like this)
- an echoed `Authorization: Bearer …`, `api_key=…`, `X-API-KEY: …`
- any bare token of 32+ key-ish characters

A model's explanation is clipped to roughly two sentences **in the composer**, so
no caller can opt out. The long version belongs in the audit trail where it can
be read at leisure; in a chat it buries the fact.

Unit numbers and chat ids survive untouched — a sanitiser that redacts
`-1001234567890` is worse than none.

## The outbox

`operational_notifications`, the same shape three earlier queues earned:

- claim with `FOR UPDATE SKIP LOCKED` under a lease
- **increment `attempts` at claim time**, so a worker that dies mid-send still
  burns an attempt and a crash loop stays bounded
- compute the backoff **inside the failing UPDATE** from the row's own counter,
  so the delay cannot drift from it (`GREATEST(attempts, 1)` is load-bearing:
  PostgreSQL arrays are 1-based, and `NOW() + NULL` violates NOT NULL)
- reach a terminal `abandoned` rather than retrying forever, **and count it** on
  `/api/health` → `queues.operationalNotifications`

The drain rides the operations sweep rather than a timer of its own: a notice is
always about something that sweep just did or found, and a second timer is a
second thing to notice had stopped.

## What was deliberately NOT changed

The six existing destinations keep working exactly as they are. Home Time still
posts its three manager notices to `completed_notify_group_id`, because that
chat is chosen for a different audience and moving it would be a behaviour change
nobody asked for. This is for new operational categories, and for anything later
migrated onto it deliberately, one feature at a time.

## When there is no destination

Nothing is recorded and nothing is queued. That is deliberate: enqueuing would
build a backlog that fires months of stale alerts into a live staff chat on the
day somebody finally sets a group — which is exactly what this repository decided
**not** to do with 98 expired home-time alerts.

The admin screen says so out loud rather than showing an empty field.

## The first consumer: automatic corrections

The correction engine has applied changes in the background since Phase 3 —
audited, capped, revertible, and **completely silent**. An operator who first
learned of a correction by noticing a driver's state had changed was given a
mystery rather than a service.

`services/operations/correctionNotices.js` announces each pass, after the
transaction commits. Two limits shape it:

- **One notice per CORRECTION**, keyed on the correction id. Keyed on the
  finding, the same problem found again would re-announce the old fix.
- **A batch is one message.** The engine can apply up to its per-check cap in a
  single pass; twenty-five messages about twenty-five closed cycles is noise
  nobody reads, and the one that mattered is buried in it. Above four, the notice
  summarises by action and points at Needs attention → History.

The wording lives in `lib/operations/correctionLabels.js` and is deliberately
**not** the same vocabulary as the admin's check labels. Those name the problem
for someone browsing a list ("Home stay never closed"); a notice arrives after
the fact and must name the fix in the past tense ("Closed a home stay that was
left open"). `tests/operationsNotices.test.js` fails when a registered action has
no description, so a new correction cannot ship announcing itself as a key.
