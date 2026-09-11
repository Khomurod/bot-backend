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

## How urgent, and one driver's bad morning

Two rules run inside the one door, between resolving the destination and
enqueuing. Both lived in `lib/notifications/priority.js` with passing tests and
**no caller at all** until they were wired here; the module was reachable only
from its own test file, so every notice left at whatever urgency its category
was catalogued with.

### The level

`priorityFor({ severity, facts })` returns `now` / `today` / `whenever` from
**established numbers only** — a distance, a percentage, a count, an
hours-until-due. It has no parameter a model could reach, and a test asserts
that.

A caller may state the severity of **this** event, and it is used in preference
to the category's. That is the point: `fuel` is catalogued as a `warning`,
which is right for a truck at 28% twenty miles from a station and wrong for one
that cannot reach its assigned stop at all — and the second is the one that
costs money. **An unrecognised severity falls back to the category's, never to
the loudest reading**, so a typo cannot page anybody.

Only a `now` explains itself, as one extra line. A `today` that argued its own
urgency on every notice would be the noise this exists to reduce. The level is
written into `evidence_json` either way, so a screen can show *why* something
was urgent rather than only that it was.

### The hold

`shouldSuppress` answers the question the notice key cannot: a fuel risk, a
load contradiction and a retention signal about **one driver** arriving within
minutes, each correctly deduplicated against itself, together reading as three
problems rather than one person having one bad morning. Grouping is by person
first, then group, then subject pair — never by category, since those three
*are* three categories.

The fourth notice about one subject inside an hour is **held, never dropped**.
The row is still written; `next_attempt_at` is pushed out by exactly the window
that crowded it out, and the drain delivers it afterwards. This repository has
already lost 101 alerts to a queue that gave up quietly, and a suppression that
discarded would be that failure with a nicer name.

Two exceptions, both deliberate:

- **a `now` is never held.** Whatever else somebody has been told, a thing that
  gets worse by the hour is worth the interruption. A **critical fuel
  percentage** is one on its own, with no assigned stop to measure against —
  that was missed at first, so a truck at 6% with no open fuel watch produced
  no facts at all, landed at `whenever`, and could be held for an hour. The
  threshold is imported from `lib/fuel/risk.js` rather than copied.
- **the hold fails open.** A dependency map without the new read, or a read
  that errors, costs the hold and not the notice. Saying a thing twice is a
  nuisance; not saying it is the failure this application exists to remove.

Three things the first version of the hold got wrong, each found in review:

- **it moved the flood rather than removing it.** Every held row was dated
  forward by the same window, so a hundred notices became three now and
  ninety-seven together an hour later. Each notice already waiting for a
  subject now pushes the next a further window out.
- **it counted notices nobody in that chat had seen.** With per-category
  overrides, three fuel notices in the fuel team's chat could hold the first
  safety notice in a safety chat. Both the recent-notice read and the stagger
  count are scoped to the resolved destination.
- **it created the duplicate it exists to prevent.** `noticeSentWithin` looked
  only at `delivered`, and the fuel watch's discriminator carries the hour — so
  a notice held at 10:30 was invisible, the key changed at 11:00, and a second
  copy went out. A `pending` row will still be said, so it now counts;
  `abandoned` does not, because it never will.

The read is `listRecentNoticesAbout`, over the index migration 0031 created for
exactly this — `(person_id, created_at DESC) WHERE person_id IS NOT NULL` — and
which nothing had used until now.

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


## With no destination configured, the absence is LOUD

`resolveDestination` returns `via: 'none'` when no default chat id is set, and
`notify()` then records nothing and queues nothing — deliberately, so a group
configured months later cannot deliver a backlog of stale alerts into a live
staff chat.

The cost of that correct decision is that **every feature which speaks would
run, work, and say nothing** until somebody opened a settings screen they had no
particular reason to know existed. That is the exact shape of the failure this
whole project started from: the outbox retried, backed off, gave up, recorded
the error, and told nobody.

So the gap is reported in the two places an operator already looks:

- **Needs Attention** — `ops.no_notification_destination`, `serious` when
  nothing at all is configured and `warning` when some categories are set and
  the rest fall through to nowhere. The evidence names what is being lost and
  where to fix it.
- **`/api/health` → `operations.notifications`** — `reachable`,
  `defaultConfigured`, `categoryOverrides`. **No chat id is ever published
  here**: a group id is enough to attempt a join, and the question worth
  answering on a health check is whether anybody is receiving, which is a
  boolean.

**A destination is never guessed.** Seeding the default from another feature's
settings would put fuel risks and retention signals into a room chosen for a
different audience, and that is a decision for a person. A missing settings row
files nothing at all — a deploy in progress is not a misconfiguration.
