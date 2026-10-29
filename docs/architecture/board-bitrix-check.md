# The Dispatcher Board ↔ Bitrix24 check

**Read this before changing anything under `lib/boardBitrix/`,
`services/boardBitrix/`, `database/boardBitrix.js` or
`bot/handlers/boardBitrixReplyHandlers.js`.**

The owner, 29 October 2026: compare the active drivers on the Dispatcher Board
with the active drivers and active trucks in Bitrix24, and say every difference
in the Telegram group where "something does not look right" already goes.
Decided with the owner the same day:

- **The Dispatcher Board is the source of truth.** Every difference is
  something to correct in **Bitrix**.
- Each difference is a **question, asked one at a time** in the
  **Needs-attention** group, as soon as it is found when nothing else is out.
- The owner fixes Bitrix and **replies "done"** to the question; Wenze re-reads
  Bitrix at once, **confirms** and asks the next — or says what is still
  different. "skip" brings it back tomorrow.
- A difference of a letter or two, an extra space or the other word order in a
  name is the **same person** and is not asked about.
- Board `HOME` = Bitrix HOME, `SHOP` = SHOP, `VACATION` = VACATION (a driver on
  vacation is not working), every working word = WORKING; a driver not on the
  Board should be TERMINATED / LEFT / RESIGNED. A Bitrix `NEW` with no Board line
  is a difference too.
- The status is compared as well as the driver and the truck.

AI matching of names a person would still recognise as the same driver is the
second step (not built yet); today those are asked.

## Where Bitrix keeps drivers and trucks

Read from the portal on 29 October 2026 by the owner's Bitrix agent (read-only).
`lib/boardBitrix/vocabulary.js` holds every code.

| | Where | Active |
|---|---|---|
| Driver | deal, pipeline **3** "4. DRIVER RELATION" | `STAGE_SEMANTIC_ID = 'P'` (NEW, HOME, VACATION, SHOP, WORKING); TERMINATED / LEFT / RESIGNED are `F` |
| Truck | smart process **"Trucks"**, `entityTypeId 1040` | stage "On the road", "Drivers at shops", "Driver will stop soon and leave" |
| Driver → truck | the deal's `UF_CRM_ASSIGNED_TRUCK` (the truck item's id) | |
| Driver type | the deal's `UF_CRM_PERF_DRIVER_TYPE`: 361 Company, 363 Owner Operator, 395 Lease | |
| Team | two deals pointing at one truck | |

**Never read:** pipeline 33 (copies of the same drivers for home time — counting
it would double everybody), the old text field `UF_CRM_DRV_TRUCK` and the
truck's `parentId2` (both stale), and the truck's own ownership field (often
contradicts the driver's deal — the fleet comes from the deal).

The truck number lives only inside the truck's title ("Trucks #001",
"Unit# 888", "008", "Trucks #007 (USMON)"); `lib/boardBitrix/trucks.js` reads it,
**leading zeros kept**. Company 001 and Lease 001 are two trucks
(`docs/architecture/fleet-type-and-unit-identity.md`), so a truck is the
driver's fleet plus that number.

## Invariants — do not undo

- **Bitrix is only read.** `services/boardBitrix/bitrixRead.js` calls
  `crm.deal.list` and `crm.item.list` and nothing else; `tests/boardBitrixPass.test.js`
  asserts every call is a `.list`. "done" means a person changed Bitrix.
- **Nothing is decided from an incomplete read.** The pass stops before the
  queue is touched when the check or the Board feed is off (`blocked`), Bitrix
  is not connected (`blocked`), the Board has not been read successfully within
  twice its own interval (at least 30 minutes), the Board snapshot names nobody
  or may be cut off (5 000 lines), Bitrix returns no active driver, any page
  fails, an ACTIVE list (drivers, trucks) is longer than one pass reads (2 000),
  or a field the comparison needs no longer comes back (`error`). Resolving or
  asking from half a list would call every driver on the missing pages "not in
  Bitrix".
- **Closed deals are read newest first, and only the newest 500.** They grow
  forever and only sharpen a question asked anyway — a Board driver with no
  active deal is "closed in Bitrix" when the closed deal is recent and "no deal"
  when it is older; both are true. So a long closed list is never a failure
  (found in the code review before the first deploy: years of closed drivers
  would otherwise have stopped the check for good).
- **One situation is one question.** A seat whose Board name and Bitrix name are
  too different to pair is ONE `name_differs` question about the truck, not a
  "missing" plus a "not on the Board"; a deal titled with two people is one
  `two_names_in_deal` question and the people it names are not also reported
  missing; an active truck is asked about only when NO active deal points at it.
- **A question's key names its subject — the deal, the truck or the person —
  never its values**, so a question whose details change stays one question and
  shows the new details, and a difference that comes back reopens its own row
  (`times_reopened`). The table is bounded by the fleet's size.
- **One question out at a time**, held by the database
  (`uniq_board_bitrix_one_asked`), not by the code that checks first. Most
  important first: who is missing, then names and duplicates, then the truck,
  then the status, then the driver type.
- **A question nobody answers is posted again after 24 hours** as a reminder —
  the same question, at the bottom of the chat — instead of every later
  question waiting behind one scrolled out of sight. **Switching the check off
  puts the question out back in line**, so switching on asks it afresh.
- **An unknown fleet never wins a choice between two trucks with one number**
  (`sameSeat`): a Board line whose fleet is unknown pairs by truck only while
  every deal on that number is one fleet; a known fleet takes deals of its own
  fleet, or failing those deals with no driver type, never another fleet's.
- **Links go on their own lines.** The composer clips a line at 160 characters;
  a link at the end of a long line would lose the end of its deal id, and
  Telegram would still link what was left — to a different deal.
- **Only an operator is listened to.** The reply handler uses the control
  channel's allow-list (`control_operators`); a stranger's reply is consumed and
  never answered. A redelivered Telegram reply is claimed once per question
  (`claimReply`). The handler sits right after the learning questions' handler
  (`tests/boardBitrixReply.test.js` asserts the order).
- **No model reads the reply.** "done" / "skip" in English or Russian
  (`lib/boardBitrix/replyIntent.js`); **any negation makes a reply unclear**
  ("haven't fixed it yet", "не всё готово") — never "done"; anything unclear
  gets one line saying what to type.
- **A "done" that the timer's pass beat to it says nothing more**: the pass has
  already said "Fixed" under the question and asked the next; a second
  confirmation would arrive after the next question.
- **The questions carry no `question_json`**, so the control channel's buttons,
  standing cap, daily budget and morning summary never touch them — the same
  arrangement as the AI learning questions (`docs/architecture/ai-learning.md`).
- **Counts only on the settings card.** No driver name and no truck number on
  Settings → Dispatcher Board; those are in the question in the group.
- **Passes never overlap** (`runExclusive`): the 15-minute timer and the
  re-check after "done" queue behind each other in this process.
- **Off until switched on** (`board_bitrix_settings.enabled` defaults FALSE), so
  a deploy asks nobody anything by itself. Switching on runs a pass at once.
- **Stood down in economy mode** with the other automatic checks and the
  questions they raise (`lib/operations/economyMode.js`): no pass, no new
  question, no reminder — "skip" included; while paused, "done" is answered
  with "could not check".
- **An unchanged difference is not rewritten.** One batched upsert per pass;
  a row whose details are the same is left alone (`last_changed_at` moves only
  on a change), so a quiet fleet costs the database almost nothing.

This is **not** the Board identity work removed in October 2026
(`docs/architecture/dispatcher-board.md` → What was removed): it links no Board
row to a person, writes nothing to `driver_people` or `dispatch_board_rows`, and
files no operations finding. It compares two outside systems and asks a person.

## What each difference is

`lib/boardBitrix/compare.js` pairs Board drivers with Bitrix deals in three
passes — the same truck with a compatible name (one word is enough on the right
truck: Bitrix titles are often a first name), then the same name across the
fleet, then one truck with two different names — and compares each pair.

| Kind | Means |
|---|---|
| `missing_in_bitrix` | on the Board, no deal at all |
| `inactive_in_bitrix` | on the Board, the deal is closed (the newest closed deal is named) |
| `not_on_board` | an active deal (NEW included) with no Board line |
| `name_differs` | one truck, a Board name and a Bitrix name that do not match |
| `duplicate_deals` | one Board driver, more than one active deal |
| `two_names_in_deal` | one deal titled with two drivers ("Prince/Otis") |
| `truck_differs` / `truck_missing` | the deal's assigned truck is another number / none |
| `truck_inactive` | the assigned truck is not on the road (not asked for a driver on VACATION) |
| `truck_without_driver` | an active truck no active deal points at |
| `status_differs` | the deal's stage is not the one the Board's status maps to |
| `fleet_differs` / `fleet_missing` | the deal's driver type differs / is empty |

A Board line naming nobody yet ("OPEN", "AVAILABLE", …) is not a driver. A
Board status Wenze does not know is never compared.

## Where things are

| | |
|---|---|
| `database/migrations/0088_board_bitrix_check.sql` | `board_bitrix_settings` (the switch) and `board_bitrix_discrepancies` (the queue) |
| `lib/boardBitrix/` | pure: `vocabulary` (Bitrix codes), `names`, `trucks`, `compare`, `wording`, `replyIntent` |
| `services/boardBitrix/bitrixRead.js` | the two list reads, complete or failed |
| `services/boardBitrix/pass.js`, `timer.js` | one pass; the 15-minute timer, `board_bitrix_check` in the roster |
| `services/boardBitrix/ask.js`, `reply.js` | one question at a time; "done" / "skip" |
| `database/boardBitrix.js` | the switch, the one-transaction pass, the queue |
| `bot/handlers/boardBitrixReplyHandlers.js` | registers the reply handler |
| `services/boardBitrix/admin.js`, `server/routes/settings/boardBitrixRoutes.js` | `GET /board-bitrix`, `PUT /board-bitrix/enabled`, `POST /board-bitrix/run` under `/api/settings` |
| `admin/src/pages/settings/dispatcherBoard/BoardBitrixCard.jsx` | the card under the Feed card |

## Tests

```
node --test tests/boardBitrixNames.test.js tests/boardBitrixCompare.test.js tests/boardBitrixPass.test.js tests/boardBitrixReply.test.js tests/boardBitrixAdmin.test.js
TEST_DATABASE_URL=… node --test tests/boardBitrixPg.test.js
npm test --prefix admin -- --run src/pages/settings/dispatcherBoard/BoardBitrixCard.test.jsx
```
