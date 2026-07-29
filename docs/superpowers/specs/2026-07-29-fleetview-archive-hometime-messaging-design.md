# FleetView archival + Home-Time internal clarification messaging

Date: 2026-07-29
Status: approved
Baseline commit: `e6a6bb7`

Three independent changes ship together:

1. FleetView is archived to a tag and removed from the production runtime.
2. Home-Time gains a driver-messaging switch and an internal clarification group.
3. The Home-Time classifier learns to reject ordinary operational conversation.

---

## 1. FleetView archive and removal

FleetView lives in `fleet/` (Vite SPA) and `server/fleet/` (Express router, sync
job, snapshot cache). It is mounted from exactly one place — `server/api.js` —
which also starts its background snapshot sync.

### Archive

An annotated tag `archive/fleetview-disabled` at `e6a6bb7`, pushed as a tag.

Pushing a *branch* to this repository can auto-open and auto-merge a PR into
`main` within seconds (`CLAUDE.md`). An archive branch would contain FleetView
intact, so an auto-merge would silently undo this removal. Tags do not trigger
that automation, so a tag is the only safe archive mechanism here.

Recovery: `git checkout archive/fleetview-disabled -- fleet server/fleet`.

The tag's tree must be verified to contain the complete feature *before* any
deletion commit is made.

### Removed from `main`

| Item | Action |
| --- | --- |
| `fleet/` | delete |
| `server/fleet/` | delete |
| `server/api.js` FleetView mount block | delete |
| `package.json` `postinstall` fleet install+build | delete |
| `tests/fleet.test.js`, `fleetReal.test.js`, `fleetIsolation.test.js`, `fleetDataTruckAdapter.test.js` | delete |
| `tests/assetMapFilters.test.js` | rewrite against the surviving `admin/` copy |
| `.env.example` `FLEETVIEW_*` block | delete |
| `scripts/fileSizeBaseline.json` fleet entries | delete |
| `AI_PROJECT_PRIMER.md` FleetView sections | replace with a pointer |
| `docs/ARCHIVED_FEATURES.md` | new |

`mountFleet()` is the only caller of `startFleetviewSyncJob()`, so deleting
`server/fleet/` stops the background job. `/api/v1/*` and `/update/*` stop being
routed.

### Database

FleetView creates its tables lazily at runtime with `CREATE TABLE IF NOT EXISTS`
inside `server/fleet/realDb.js` and `server/fleet/snapshotRepository.js` — they
are **not** in `database/schema.sql`. Deleting that code removes the only thing
that ever creates them, which is the requirement ("stop them creating a table").

Tables already present in production are **left in place**: `fleet_snapshots`,
`fleet_unit_snapshots`, `fleet_tasks`, `fleet_task_comments`,
`fleet_task_activity`, `fleet_audit_log`, `fleet_sync_log`, `fleet_sync_runs`,
`fleet_settings`. No `DROP` migration is written — that would be a destructive
change nobody asked for, and keeping the rows keeps the feature recoverable.
Once the code is gone nothing reads or writes them.

### `docs/ARCHIVED_FEATURES.md`

States where FleetView is preserved, how to restore it, which tables were left
behind, and that AI agents should not scan or modify the archived feature unless
specifically asked.

---

## 2. Home-Time messaging controls

The existing **Tracking enabled** switch keeps its current meaning — it gates the
whole feature. Two new settings sit beside it.

### Migration `0001_home_time_internal_clarification.sql`

Additive and idempotent (`ADD COLUMN IF NOT EXISTS`), kind `schema`:

```
home_time_settings.driver_clarification_enabled  BOOLEAN NOT NULL DEFAULT TRUE
home_time_settings.internal_clarification_group_id TEXT
home_time_requests.clarification_channel  TEXT   -- 'driver' | 'internal'
home_time_requests.internal_alert_sent_at TIMESTAMPTZ
```

`driver_clarification_enabled` defaults `TRUE` so existing behaviour is
preserved on deploy. Both settings columns join `SETTINGS_COLUMNS` in
`database/homeTime.js` and are validated in `PUT /api/home-time/settings`;
the group id reuses `normalizeNotifyGroupId` (numeric, optionally negative,
`''` clears) so validation matches `completed_notify_group_id`.

### `services/homeTimeDriverChannel.js`

The single choke point for every driver-group send.

```
isDriverMessagingEnabled(settings)
sendToDriverGroup(telegram, chatId, text, opts, { settings })
reactToDriverMessage(telegram, chatId, messageId, { settings })
```

Both send functions return `null` without touching Telegram when the setting is
off. `sendReply()` and `reactThumbsUp()` in `homeTimeRequestService`, the
clarification flow, and the reminder sweep all route through it. Because there
is one choke point, no send site can leak: clarification questions, reminders,
acknowledgments, reactions and policy warnings are all suppressed together.

Completed approval cards go to `completed_notify_group_id`, which is a different
chat and was never the driver group, so they are unaffected.

### `services/homeTimeInternalAlert.js`

```
buildInternalAlertText({ ... })            -- pure, unit-testable
notifyInternalClarification(telegram, { request, group, message, verdict, settings })
```

Tags `@tomr_robins0n` and `@SaffieBNett` by reusing the existing
`HOME_TIME_APPROVER_MENTIONS` constant rather than duplicating the list.

Contents: driver name and unit number, source driver-group name, original
message text, a link to the original message when derivable, the detected
intention, dates already identified, dates still missing, a brief classification
reason, and an explicit request for staff to clarify the exact dates.

Message link: `https://t.me/c/<id without leading -100>/<message_id>` for
supergroups, `https://t.me/<username>/<message_id>` when the group has a public
username, omitted when neither is derivable.

Duplicate prevention is DB-atomic, mirroring `markHomeTimeAcknowledged`:

```sql
UPDATE home_time_requests SET internal_alert_sent_at = NOW()
WHERE id = $1 AND internal_alert_sent_at IS NULL RETURNING *
```

Only the winner sends. Concurrent ticks, retries and restarts cannot double-post.

When `internal_clarification_group_id` is unset, the alert is skipped with a
logged warning. The request is still created, recorded and visible in the admin
panel — a missing group must never lose the request.

### Behaviour when driver messaging is disabled

Unchanged: reading and analysing driver-group messages, identifying genuine
home-time intentions, recording request/dates/status/AI reasoning, reading later
messages and silently capturing dates the driver supplies, and the completed-
request approval-card flow once both dates are known.

Suppressed: every clarification question, reminder, acknowledgment, reaction and
policy warning to the driver group.

New requests are stamped `clarification_channel = 'internal'`; when messaging is
on they are stamped `'driver'`.

### Reminder safety in both directions

- Created while disabled → `next_reminder_at` is `NULL`. Nothing is scheduled,
  so nothing can later leak.
- Scheduled while enabled, then disabled → the sweep clears `next_reminder_at`
  **without sending**, without incrementing `reminder_count`, and without
  marking `clarification_unanswered`. The request stays in its `awaiting_*`
  status for staff to resolve.

Together these mean turning the setting off stops future driver-group reminders
immediately, and turning it back on replays nothing and fires no backlog.

### Admin panel

`HomeTimeSettingsCard` gains both controls with descriptions:

- **Send clarification messages to driver groups** (checkbox) — when off, the
  bot keeps detecting and recording silently and notifies the internal group
  instead.
- **Internal clarification notification group ID** (text) — validated Telegram
  chat id.

Status rendering: when `clarification_channel === 'internal'` and the status is
one of the `awaiting_*` values, the badge reads **Awaiting staff clarification**.
The stored status value is unchanged, so `missingFieldFor()`,
`statusForMissingFields()`, the reminder queries and the completion path all
keep working untouched. This is why a new column beats a new status value.

---

## 3. Detection accuracy

### Operational negative context

`services/homeTimeSignals.js` gains `OPERATIONAL_CONTEXT_PATTERNS` and
`hasOperationalContextSignal(text)` covering:

- trailer/truck repairs, breakdown, tyre, mechanic, shop, maintenance
- load, rate, BOL, paperwork
- pickup, delivery, shipper, receiver
- yard, terminal, parking
- ETA, appointment, departure time

Uzbek and Russian forms are included where the driver groups actually use them
(`trailer`, `fix qil*`, `yo'lda`, `remont`, `shina`).

A message carrying operational context must not open a home-time request and
must not change home/road status, unless separate explicit time-off language is
present (`hasExplicitTimeOffSignal`). Passing by home briefly and sleeping home
one night are already covered by the existing `hasHomeErrandSignal`.

### Status-change rules

Deterministic messages (`Status: Home`, `Status: Ready`, `Status: Rolling`) keep
their existing path and are unaffected.

A non-deterministic, AI-detected status change is accepted only when **all** of:

- `senderIsDriver === true` (verified; `null` is not enough)
- the statement is first-person present-tense (`looksLikeFirstPersonStatus`)
- confidence ≥ 85 (raised from 70)
- no operational context and no temporary-stop context

Third-person staff messages therefore cannot change status or open an unplanned
-home clarification. They can still create a *request* when they clearly state
the driver is asking for real time off — that path is unchanged.

### Dates

A genuine request with a vague anchor ("my home time after tomorrow … the whole
week") must ask for exact arrive-home and return-to-road calendar dates rather
than guessing. A request with a concrete anchor plus a duration ("four days of
home time starting August 2") resolves through the existing
`homeTimeDateResolver` model as it does today. The difference is whether a
calendar anchor exists, not whether a duration was stated.

---

## 4. Refactor

`services/homeTimeRequestService.js` is 906 lines against a hard 500-line limit
(baseline entry 929). This work adds to it, so per `CLAUDE.md` it is reduced
below the limit as part of the change:

- `services/homeTimeMessageComposer.js` — the AI conversational text generation
  (`conversationalPrompt`, `generateMessage`, `generateRequestText`).
- `services/homeTimeClarificationFlow.js` — `createClarification`,
  `advanceClarification`, `completeAndRespond`, `sendPolicyResponse`.

`homeTimeRequestService.js` stays the orchestrator and keeps its current exports
so no importer changes. Its `scripts/fileSizeBaseline.json` entry is removed
once it is at or below 500 lines, locking in the win.

---

## 5. Tests

Added to `tests/homeTimeIntentAccuracy.test.js` (its mocked-Gemini harness
already fits), verbatim from the spec:

| Message | Expected |
| --- | --- |
| `700 ml yurmaydi bu trailer. Yo'lda fix qilsak bo'ladimi aka` | operational; no Home-Time action |
| `My home time after tomorrow and I'm going to stay for the whole week` | genuine request; exact dates still needed |
| `He is currently at home and will let us know once he gets to the truck` | operational ETA; no status change, no clarification |
| `Status: Home` | valid deterministic transition |
| `I need to pass by home to pick up my clothes` | temporary stop; no request |
| `I need four days of home time starting August 2` | genuine request; dates resolved by the existing model |

New files:

- `tests/homeTimeDriverChannel.test.js` — both modes; every send site suppressed
  when off; nothing suppressed when on.
- `tests/homeTimeInternalAlert.test.js` — alert contents, message-link forms,
  duplicate prevention, missing group configuration.

Extended:

- `tests/homeTimeReminderService.test.js` — no driver-group send when disabled;
  schedule cleared without bumping the count or marking unanswered; re-enabling
  replays nothing.
- `tests/homeTimeRequestService.test.js` — silent later date capture while
  disabled still completes and still posts the approval card.
- `tests/homeTimeSignals.test.js` — the new operational and first-person
  predicates.

Full suite plus `npm run build --prefix admin` and `npm run lint:filesize` must
pass before the work is complete.

---

## 6. Risks

- The auto-merge-on-push behaviour makes the archive tag the only safe archive.
  The removal commit must be reviewed in full before pushing.
- Removing `fleet/` breaks `tests/assetMapFilters.test.js`, which asserts the
  admin and fleet copies are byte-identical. It is rewritten, not deleted, so
  the surviving admin copy stays covered.
- Raising the AI status confidence floor from 70 to 85 and requiring a verified
  driver will make fuzzy status detection strictly more conservative. Official
  `Status:` lines are unaffected, so the deterministic path absorbs the volume.
