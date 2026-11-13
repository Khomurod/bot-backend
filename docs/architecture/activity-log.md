# Logs — who changed what in Bitrix, and why

**Read this before adding a Bitrix write anywhere, or before changing
`lib/activityLog/`, `services/activityLog/`, `database/activityLog.js`, the two
Bitrix clients (`services/bitrix24DealStages.js`, `services/bitrix24Service.js`)
or Monitoring → Logs.**

The owner, 14 November 2026: changes appeared in Bitrix and nobody could say
who made them, what changed or why. Decided with the owner the same day:

| | Decision |
|---|---|
| (a) | Entries are kept **one year**. |
| (b) | Only **super administrators** may open Monitoring → Logs. |
| (c) | **Everything, in time order, newest first** — changes AND refused or failed attempts, **each attempt its own entry**. |
| (d) | The owner gets **a Telegram notice when Bitrix refuses or fails several times in a row**. |
| (e) | After **60 days** the driver's / candidate's **name** is removed from an entry; the deal number (the ids) stays. |

## The rules

- **A write cannot happen unseen.** The recording sits in the Bitrix CLIENTS,
  not in the features: `call` in `services/bitrix24DealStages.js` (also
  exported as `callBitrix`) records every `crm.*.add|update|delete` —
  `crm.item.update` included — and the Facebook lead creation in
  `services/bitrix24Service.js` records its `crm.lead.add` / `crm.deal.add`.
  A read (`.get`, `.list`, `.fields`, `findbycomm`) is never recorded.
- **Recorded after the write, never in its way.** The entry is written once
  Bitrix has answered (or not): `done`, or `failed` / `refused` with Bitrix's
  own words. A failed insert is logged to the console and swallowed — the
  write has already happened and its result goes back to the caller unchanged
  (`tests/activityLogBitrixWrites.test.js` "a failed log insert never fails the
  write").
- **Every write call site passes an audit context** —
  `{actorKind, actorTelegramId, actorAdminId, actorName, trigger, reason,
  evidence, targetLabel, change}`: as `opts.audit` to a client helper or as the
  third argument of `callBitrix`, and as `audit` to `createCrmRecordFromLead`.
  **At runtime a missing context never blocks a write**: it is recorded as
  `unknown`, with the reason "the code that made this change did not say who
  or why", and one console warning per method. **A test keeps it from being
  the normal case**: `tests/activityLogCallSites.test.js` reads every module
  under `services/`, `server/` and `bot/` and fails on a write call or helper
  call without `audit`, a write method built from a template, or a raw webhook
  request to a write method outside the two clients.
- **Bitrix said no = `refused`; no answer = `failed`.** A 4xx / "access
  denied" / a refused field is `refused`; a timeout, a 5xx, a network error or
  Bitrix not connected is `failed`. A write Bitrix did not confirm (`update`
  not `true`, `add` without an id) is `failed`.
- **The Telegram id is the evidence; the name is a label.** `actor_name` is
  what Telegram showed at the press. One human per account
  (`docs/architecture/telegram-identity.md`) is what makes the id evidence.
- **An entry never holds a secret, a phone number or chat text.** No URL
  survives (`stripUrls`), a webhook path (`rest/<n>/<code>`) is removed, a
  10–15-digit number becomes "[number removed]", `PHONE` / `EMAIL` /
  `COMMENTS` / `IM` / `WEB` / `ADDRESS` / `ORIGIN_*` are never copied into
  `change`, evidence keeps scalars only, the error is clipped to 400
  characters. The lead creation passes the recorder NO fields at all.
- **Names live 60 days.** `target_label`, the from → to of a name field
  (`TITLE`, `NAME`, `LAST_NAME`, `SECOND_NAME`, `FULL_NAME`) and name keys in
  `evidence` are removed by the hourly retention pass after 60 days
  (`names_scrubbed_at` marks a row done, so each is rewritten once, 2 000 a
  pass). The row itself goes after 365 days. Never put a name in `reason`.
- **Append-only.** The only UPDATE is that scrub and the only DELETE is the
  year; nothing else changes a row.
- **The owner is told once.** Three `failed` / `refused` entries in a row for
  one feature (`trigger`) with no `done` / `already_done` between → ONE
  operational notice, category `system_errors`, through
  `services/notifications/send.js` (so routing, the outbox and the sanitiser
  apply — see `operational-notifications.md`). The notice key ends in the
  streak's first entry, so the outbox says it once per streak; never more than
  one per feature in six hours (`noticeSentWithin`); a success ends the streak.
  A streak whose start is older than the 20 entries read was decided on when
  it crossed three, and is not announced again. Plain words, no code, no name:
  "Bitrix: 3 changes in a row did not go through", where, the latest reason,
  "see Monitoring → Logs". The rule is pure: `lib/activityLog/failureStreak.js`.
- **Every attempt is its own entry**, including the ones that never reached
  Bitrix: the status sync's guards ("the Dispatcher Board status changed after
  the comparison", "the deal stage changed after the comparison", the kill
  switch) are `refused`, a transition Bitrix already had is `already_done`, a
  verification read that disagrees after a done write is `failed`
  (`recordAttempt`). A Board ↔ Bitrix button whose fix is refused before the
  write ("changed meanwhile") is a `refused` entry too. A write the client
  recorded is never recorded a second time by its caller.
- **Read-only screen, super administrators only.** `GET /api/activity-log`
  (`server/routes/activityLogRoutes.js`) is behind `requireSuperAdmin` — by
  ROLE, like Settings → Secrets — and the sidebar shows Logs to super
  administrators alone. No retry, no revert, no automatic refresh.
- **Bounded, indexed reads only.** A page is 50 rows on
  `(occurred_at DESC, id DESC)` with a cursor; a feature filter uses
  `(trigger, occurred_at DESC)`; a number search is exact on
  `(target_type, target_id)`; a name search only reads the last 61 days (no
  older entry has a name). The streak reads at most 20 rows of one feature, and
  only after a failure.

## Who is recorded, per write

| Feature (`trigger`) | Write | Actor |
|---|---|---|
| `board_bitrix.button` | a fix's `crm.deal.update` (`STAGE_ID`, `TITLE`, driver type, assigned truck) | `person_button` — the presser's Telegram id and name |
| `board_bitrix.reply` | the same, asked for in a typed reply ("do fix 2") | `person_reply` |
| `board_bitrix.sync` | the live status sync's `STAGE_ID` | `automatic`; evidence: Board status and its time, the action key, the attempt (`board_bitrix_stage_sync_actions.attempts`) |
| `hiring_stage.move` | Move's `crm.deal.update` `STAGE_ID` | `person_button` (the presser, as `decided_by` in `hiring_stage_proposals`) |
| `hiring_stage.rename` | ✏️ Rename's `TITLE`, and a placeholder contact's `NAME` / `LAST_NAME` | `person_button` |
| `hiring_stage.create` | `crm.contact.add`, `crm.deal.add` | `automatic`; evidence: chat and post id, the creation record |
| `home_time.violation_card` | the pipeline-33 card's stage and home-time fields | `automatic`; evidence: driver group, violation row ids, home-from |
| `facebook_lead.create` | `crm.lead.add` / `crm.deal.add` | `automatic`; evidence: leadgen, form and page ids |

## The run ledger

A Board ↔ Bitrix pass whose status updates failed or were refused now sets
`error` ("N of M Bitrix status update(s) failed or were refused this pass —
see Monitoring → Logs") — `health-reporting.md`'s rule that the pass decides
and says so in `error`. Until 14 November 2026 those failures sat in
`syncFailed` and the ledger recorded the pass as plain `ok`. The pass also
says `compared: true`, so a person's "done" still trusts the comparison
(`services/boardBitrix/answer.js`).

## Adding a write

Pass `audit` from the call site, name a new `trigger` in
`lib/activityLog/failureStreak.js` `TRIGGER_LABELS` (the screen's feature
filter and the notice use it), and add the call site to the table above. Run
`tests/activityLogCallSites.test.js`.

## Where things are

| | |
|---|---|
| `database/migrations/0105_activity_log.sql` | `activity_log` and its indexes |
| `lib/activityLog/entry.js` | pure: what a write becomes, what an entry may hold, `refused` vs `failed` |
| `lib/activityLog/failureStreak.js` | pure: the streak, the notice decision and words, the feature labels |
| `database/activityLog.js` | insert, the page, the streak read, the name scrub, the year |
| `services/activityLog/record.js` | `recordBitrixWrite` (both clients), `recordAttempt`; never throws |
| `services/activityLog/failureNotice.js` | the streak check and the one notice |
| `services/activityLog/admin.js`, `server/routes/activityLogRoutes.js` | `GET /api/activity-log` |
| `services/operations/dataRetention.js` | names after 60 days, rows after 365 |
| `admin/src/pages/LogsPage.jsx`, `admin/src/pages/logs/LogRow.jsx` | Monitoring → Logs |

## Tests

```
node --test tests/activityLogEntry.test.js tests/activityLogCallSites.test.js tests/activityLogBitrixWrites.test.js tests/activityLogRoutes.test.js tests/boardBitrixSyncLedger.test.js
TEST_DATABASE_URL=… node --test tests/activityLogPg.test.js
npm test --prefix admin -- --run src/pages/LogsPage.test.jsx src/components/AdminSidebar.test.jsx
```
