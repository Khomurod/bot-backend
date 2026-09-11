# Smart Shift Handoff — design, and what to build when it is wanted

**Status: NOT IMPLEMENTED. Deliberately.** The owner asked for this to be
designed and written down rather than built, alongside the Operations Autopilot
work. Nothing in the repository implements it, no table exists for it, no
scheduler runs it. This document is the handoff to whoever picks it up —
possibly a later session of this same work.

Read [`APP_BRIEF.md`](../../APP_BRIEF.md) first, then
[`operational-notifications.md`](../architecture/operational-notifications.md),
which is the door every part of this would speak through.

---

## 1. What the feature is

An operations shift ends and another begins. Today the outgoing person either
writes a message by hand or writes nothing, and the incoming person starts by
scrolling a Telegram group to work out what happened.

Smart Shift Handoff is Wenze writing that briefing: **what changed on this
shift, what is still open, what somebody promised, and what to watch.**

It is not a report. A report is a list of facts that were true. A handoff is a
list of things the next person has to *do something about*, and the difference
is the whole design.

## 2. Why it was deferred, and what has to exist first

Not because it is hard. Because **a handoff is only as good as the state it
summarises**, and most of that state was built in the same phase as this
document. A handoff written in August would have said "nothing to report" while
74 home-time cycles sat silently open, 101 staff alerts were being discarded,
and no table recorded what a load was doing.

By now the following exist and are the raw material:

| Source | What it contributes | Where |
|---|---|---|
| `operational_findings` | What Wenze noticed and has not resolved | `database/operationalFindings.js` |
| `operational_corrections` | What Wenze fixed by itself, and what was reverted | `database/operationalCorrections.js` |
| `operational_notifications` | What was told to whom, and what failed to send | `database/operationalNotifications.js` |
| `load_lifecycle` | Which loads moved phase, and which are stuck or contested | `database/loadLifecycle.js` |
| `fuel_stop_alerts` + `lib/fuel/risk.js` | Who might not reach their fuel stop | `services/fuelStop/riskWatch.js` |
| `driver_safety_events` | Patterns, and anything escalated to safety | `database/driverSafety.js` |
| `driver_road_history`, `home_time_requests` | Who went home, who came back, who is overdue | `database/homeTime/` |
| `recruiting_ai_conversations` | Candidates Wenze answered overnight, and the ones it handed back | `database/recruitingConversations.js` |
| `admin_audit_log` | What a *person* changed on the shift | `database/adminAudit.js` |

**The one genuine gap is §6.** Everything else is a read.

## 3. The design

### 3.1 A shift is a window, and it has to be configured

```
recruiting_hours_settings   ← the shape to copy, NOT the table to reuse
```

`lib/recruiting/workingHours.js` already evaluates a `{timezone, windows}`
schedule correctly, including the overnight case that a naive implementation
gets wrong. **Reuse that module** — it is pure, tested, and an operations shift
is exactly the same arithmetic. What it needs is a second settings row of its
own (`shift_schedule_settings`), because shifts and recruiting hours are
different facts about different teams and sharing a row would couple them.

A shift boundary is the end of one window. The handoff fires there.

### 3.2 What goes in it, in priority order

The ordering is the product. A briefing that opens with a resolved finding has
already failed.

1. **Anything a human was asked to decide and has not.** Open
   `operational_findings` with `tier = 'approval'`, oldest first.
2. **What broke and is still broken.** `system_errors` notices in the window
   with no matching recovery, plus `operational_notifications` in `abandoned`.
3. **Promises made to people.** Recruiting conversations Wenze stood down on
   (`status = 'handed_off'`), and anyone told "a recruiter will get back to you".
   **This is the highest-value item in the whole feature** and the one a human
   handoff always drops.
4. **What Wenze changed on its own.** `operational_corrections` applied in the
   window, grouped by `action_key`, with anything reverted called out — a
   reverted correction means the machine got it wrong and the next shift should
   know before it happens again.
5. **Who is out of policy.** Drivers past the road allowance, home stays past
   the allowance, loads stuck in a phase beyond its expected span.
6. **What to watch.** Findings whose `last_seen_at` is rising — a condition
   recurring every sweep is different from one seen once.

Items 1–3 are always included. 4–6 are included only when non-empty, and the
briefing says "nothing outstanding" rather than printing empty headings.

### 3.3 Where AI belongs, and where it does not

**Every item above is a query.** The selection, the ordering and the counts are
deterministic and must stay that way: a handoff that omits an open approval
because a model thought it unimportant is worse than no handoff.

AI gets exactly one job: **turning the ordered list into three sentences at the
top.** The list itself is printed underneath, unchanged, always.

Register it as a capability (`shift_handoff_summary`) in
`lib/ai/capabilityCatalog.js` with `changesState: false` and a deterministic
fallback that simply prints the counts. `tests/aiCapabilityCoverage.test.js`
will fail if the call does not name a capability.

### 3.4 Delivery

Through `services/notifications/send.js` with a new category
(`shift_handoff`) in `lib/notifications/categories.js`, so the destination is
configurable on the same screen as everything else and falls back to the
default. **Do not invent a seventh destination**; that is the mistake
`operational-notifications.md` documents.

A handoff is long, so it will need `compose.js` raised or a
`renderLongNotice` path. Do not raise `MAX_BODY` globally — the 1200-character
budget is there because a chat notice that scrolls is a notice nobody reads.

### 3.5 Scheduling

Ride the existing consistency sweep (`services/operations/consistencyService.js`,
15 minutes) and fire when the sweep is the first one past a shift boundary.
**Do not add a timer.** A second timer is a second thing to notice had stopped,
which is the reasoning already recorded for the notification outbox.

The "first past the boundary" test needs a stored `last_handoff_at` so a
restart cannot re-send, and so a boundary missed during an outage still fires
late rather than never.

## 4. The gap that has to be closed first

**Nothing records who was on shift.** `admin_audit_log` records which admin made
a change, and `dispatch_teams` / `dispatch_team_drivers` record which dispatcher
owns which drivers, but neither answers "who was covering operations between
18:00 and 06:00".

Without it a handoff can say *what happened* but not *who it is for*, and the
"promises made to people" item cannot be attributed. Two options:

- **Cheap:** the schedule row names the destination chat per shift, and the
  handoff is addressed to a room rather than a person. Ships in a day and is
  probably enough.
- **Proper:** a `shift_assignments` table (`admin_id`, `started_at`, `ended_at`,
  `role`), with the handoff addressed to the incoming holder. Also lets
  `admin_audit_log` be read per shift, which is the more valuable half.

Start cheap. The table is additive later and nothing about the briefing changes.

## 5. What it must never do

- **Never make an employment or disciplinary judgement about a driver.** A
  handoff naming drivers is a handoff that becomes a performance record nobody
  agreed to. Name a driver only where the next shift has to *act* — an overdue
  home stay, a stuck load — and never with an assessment attached. The same
  line `services/safety/coach.js` holds.
- **Never state a figure it did not read from a table.** The same rule as
  `lib/recruiting/replyGuard.js`, and for the same reason.
- **Never replace a notice.** A handoff summarises what was already sent; it is
  not a substitute for sending it at the time. If a fuel risk only ever reaches
  anybody in a 6am briefing, the fuel feature is broken and the handoff is
  hiding it.
- **Never send an empty one.** A quiet shift gets one line. A daily message
  that is usually empty trains people to skip it, and then the one that matters
  is skipped too.

## 6. Rough shape of the work

| | |
|---|---|
| `lib/shifts/window.js` | thin wrapper over `lib/recruiting/workingHours.js`; pure |
| `lib/shifts/briefing.js` | pure: sources in, ordered sections out. **All the logic.** |
| `database/shiftSettings.js` | the schedule + `last_handoff_at` |
| `services/shifts/handoff.js` | gathers, calls the pure builder, sends |
| `lib/notifications/categories.js` | one new category |
| `lib/ai/capabilityCatalog.js` | one new capability |
| admin | one card beside the recruiting-hours one |
| tests | the pure builder against fixtures; the boundary arithmetic; a restart not re-sending; an empty shift producing one line |

Two to three days, most of it in `briefing.js` and its fixtures.

## 7. Do not start by writing code

Read one week of the operations Telegram group and write, by hand, the handoff
you wish had existed each morning. That list is the specification. Everything
above is a guess at it made from the data model, and the data model is not where
the answer is.
