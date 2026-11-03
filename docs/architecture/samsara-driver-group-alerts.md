# Samsara alerts in a driver's own group: the per-driver switch

Added 3 November 2026 at the owner's request: "I must be able to switch the
Samsara notification to a particular driver's Telegram group on or off from
Wenze, per driver, without losing the event and without touching anybody else
who receives it."

## Every place a Samsara alert is posted (checked in the code, not assumed)

All of them live in the **separate** `Khomurod/samsara-integration` service
(see [`samsara-separation.md`](samsara-separation.md)). This repository posts no
Samsara alert itself.

| # | What is posted | To whom | Bot | Where in `samsara-integration` |
|---|---|---|---|---|
| 1 | the alert (text, or one/two dashcam videos with the text as caption) | every chat that sent `/start` to the Samsara bot (the subscriber list in Redis) | notification bot (`SAMSARA_BOT_TOKEN`) | `src/broadcastDelivery.js` step 1 |
| 2 | the same alert | the "Samsara Notifications" group (`HARDCODED_GROUP_ID`), always added | notification bot | step 1 |
| 3 | the alert with the driver's caption (AI-rephrased when that is on), speeding video with the music overlay | **the driver's own Telegram group** | the main Wenze bot (`BOT_TOKEN`, send-only) | step 2 |
| 4 | "the driver bot is not in the group" appended to messages 1–2 | the chats of 1–2 | notification bot | step 3, only after 3 failed for that reason |
| 5 | a recovered dashcam video, replacing a text-only alert sent by 1–3 | the chats that got a text-only alert | the bot that sent it | `src/videoRecoveryWorker.js` → `src/videoBackfill.js` |

Both pollers (safety events, `src/poller.js`, and speeding, `src/speedingPoller.js`)
hand each event to that one function, `deliverEvent`.

**How the driver's group is found** (`src/store.js` `findGroupByUnit`, `src/routing.js`):
an active `groups` row with `group_type = 'driver'` whose `samsara_vehicle_id` is
the event's vehicle wins; otherwise the unit number parsed out of the vehicle
label is matched against the first number in the group's title, with the
driver's name as a tie-breaker. No match, and there is no driver post (rows 3
and 5 for that group simply do not happen).

## What the switch is

`groups.samsara_driver_alerts_enabled` — `BOOLEAN NOT NULL DEFAULT TRUE`,
migration 0090. Set from **Driver Groups → open the driver → "Samsara alerts in
this group"** (On / Off, saved the moment it is changed, audited as
`samsara_driver_alerts.update`). A row in the list shows "Samsara alerts in
group: off" when it is off; ON is every group's default and shows nothing.

- **Off** stops rows **3** and **5** for that one group. Nothing else.
- **On** is exactly the behaviour from before the switch existed.

### What OFF must never touch

- Rows 1, 2 and 4: the notifications group and every subscriber get each alert
  exactly as before — the same messages, videos and captions.
- The safety-event record (`driver_safety_events`, written before anything is
  sent, with the routed group's id).
- Routing, deduplication, the per-target delivery ledger, the video recovery for
  the other destinations, the music overlay settings, the caption AI settings.

## Rules

1. **Default ON, everywhere.** Every existing group and every group created
   later starts ON. A Samsara service that runs before migration 0090 (the two
   deploy separately) reads the missing column as ON and logs that once — a
   deploy-order accident can never silence driver groups.
2. **Read at the moment of sending, every time.** No cache: switching a group
   back on applies from the very next alert, and switching it off stops the
   very next one.
3. **An OFF skip is neither a delivery nor a failure.** Nothing is written to
   the delivery ledger for that group, so nothing is retried for it, and no
   "driver bot missing" note is added. Because no driver message exists, no
   video recovery can reach the group for that event.
4. **A switch that cannot be read is never guessed.** Posting would override a
   person's "off"; skipping would drop a driver's alert silently. The driver
   group is treated like any transient failure: the event is retried, and the
   destinations already delivered are not sent again (the ledger).
5. **A group switched off after its alert went out gets no recovered video.**
   Its text alert stays where it is; the recovery drops that destination as
   done. A switch that cannot be read keeps the destination for the next
   attempt.
6. **Only a driver group can be switched** (the API answers 409 for any other
   chat): it is the only kind Samsara ever posts to.
7. **The screen never claims Off is applied before it is.** The switch is
   stored here and enforced by the Samsara service, and the two deploy
   separately. Every heartbeat the Samsara service writes to
   `background_service_runs` (`samsara_safety_pipeline`) carries
   `driverGroupSwitch: true` from the build that enforces the switch. Until the
   latest heartbeat says so (`GET /api/groups/samsara-driver-alerts/status`),
   an Off group reads **"Saved, but not applied yet … alerts still reach this
   group"** in the popup, in the page message and on its row ("off (not
   applied yet)"). A status that cannot be read counts as not applied; until
   the FIRST answer arrives the screen says "checking" and claims nothing
   either way. A rolled-back service stops saying it, and the page asks again
   whenever it comes back into view — keeping the last answer on screen while
   it asks (no flicker on every focus), applying only the newest answer, and
   rebuilding a message already on screen from it. The page message is a live
   region, so a rewritten message is announced. **No freshness window, on purpose:**
   the flag says which build is deployed, not whether it is awake. A stopped
   service posts nothing, so "not posted here" stays true; any running build
   overwrites the row on its next beat. Whether the service is alive is the
   System Health `samsara_safety_pipeline` line's job.

## Real-world cases

| Case | What happens |
|---|---|
| **Team drivers** | One Telegram group, one profile, one switch — it applies to both, and the screen says so. A chat cannot receive half an alert. |
| **Telegram supergroup upgrade** (the chat id changes) | `database/telegramChatMigration.js` moves the `groups` row to the new id in place, so the switch moves with it. |
| **A truck handed to another driver** | Routing follows the truck to whichever group holds it now (its `samsara_vehicle_id`, or its title). The switch belongs to the driver's group, not to the truck: the new driver's group decides. |
| **A driver who gets a brand-new Telegram group** | A new `groups` row, which starts ON like every new group — today's behaviour. The old group's OFF does not carry over automatically: the person link between two chats can be a guess, and a guess must not silence a safety alert. Switch the new group off on its row if needed. |
| **Two active groups for one driver** (a duplicate) | Each chat has its own switch; the alert goes to whichever one routing picks. The duplicate itself is flagged for review on the same page. |
| **No group / unmapped vehicle** | No driver post today; the switch is never consulted. |
| **Inactive group** | Routing already skips it; the switch keeps its value for when the group is active again. |

## What is deliberately NOT governed by this switch

- **The Samsara subscriber list** (row 1). It is the notification bot's own
  opt-in list (`/start` / `/stop` in any chat), a general recipient like the
  notifications group. If a driver group had ever subscribed itself with
  `/start`, it would keep getting the notification-bot copy until `/stop` is
  sent there.
- **The safety coach** (`services/safety/coach.js`, this repository): a
  pattern note ("the truck logged N harsh-brake events…") posted by Wenze, not
  by Samsara, through the driver channel (`services/homeTimeDriverChannel.js`)
  and its silent mode. It is safety processing, not a Samsara notification.

## Where it lives

| Piece | File |
|---|---|
| Column | `database/migrations/0090_samsara_driver_group_alerts.sql` |
| Write + audit | `database/samsaraDriverGroupAlerts.js`, `PUT /api/groups/:groupId/samsara-driver-alerts` in `server/routes/driverGroupsRoutes.js` |
| Read for the page | `database/db.js` `listGroupDirectorySourceRows` → `services/driverGroupDirectoryService.js` → `GET /api/driver-profiles` |
| Screen | `admin/src/pages/groups/SamsaraAlertsSwitch.jsx` (in `DriverDetailModal.jsx`), the "off" line in `DriverProfilesTable.jsx` |
| **Enforcement** | `samsara-integration`: `src/driverGroupSwitch.js` (the read), `src/broadcastDelivery.js` step 2, `src/videoRecoveryWorker.js` `deliverVideo`, wired in `index.js` |
| "Is it applied?" | `samsara-integration` `src/hubHeartbeat.js` (`driverGroupSwitch: true` on every beat) → `getSamsaraSwitchEnforcement` in `database/samsaraDriverGroupAlerts.js` → `GET /api/groups/samsara-driver-alerts/status` → `admin/src/pages/groups/samsaraSwitchText.js` |

## Tests

- `tests/samsaraDriverGroupAlertsPg.test.js` — existing groups read ON after the
  migration, new ones start ON, one group is switched without touching another,
  a non-driver chat is refused, Driver Groups shows the saved value, a
  supergroup upgrade keeps it, the exact read the Samsara service runs, and
  "applied" only while the latest heartbeat carries the capability.
- `tests/samsaraDriverGroupAlertsRoutes.test.js` — only a real boolean, 404 /
  409, the audit row, no detail on a 500, and `enforced` in the answer and the
  status read.
- `admin/src/pages/groups/samsaraAlertsSwitch.test.jsx` — On / Off are visible,
  a change calls the group endpoint and re-reads, the table shows Off, the team
  note by the page's own team rule (second name, or "A / B" in the title), the
  inactive note, no switch on a company chat, and "saved, but not applied yet"
  everywhere until the Samsara service says it honours the switch.
- In `samsara-integration`, `tests/driverGroupSwitch.test.js` — OFF posts
  nothing to the driver group while the notifications group and subscribers get
  identical messages, the event is still recorded, the ledger is untouched for
  the driver group; ON is call-for-call identical to a run without the switch;
  an unreadable switch retries without re-sending; the recovery drops a
  switched-off group and keeps an unreadable one. `tests/hubHeartbeat.test.js`:
  every beat carries the capability.
