# The Dispatcher Board ↔ Bitrix24 check

**Read this before changing anything under `lib/boardBitrix/`,
`services/boardBitrix/`, `database/boardBitrix.js`,
`database/boardBitrixSchema.js` or
`bot/handlers/boardBitrixReplyHandlers.js`.**

The owner, 29 October 2026: compare the active drivers on the Dispatcher Board
with the active drivers and active trucks in Bitrix24, and say every difference
in the Telegram group where "something does not look right" already goes.
Decided with the owner the same day:

- **The Dispatcher Board is the source of truth.** Every difference is
  something to correct in **Bitrix**.
- Each difference is normally a **question, asked one at a time** in the
  **Needs-attention** group, as soon as it is found when nothing else is out.
  An administrator may separately put status differences into dry-run or live
  sync; every other kind always remains a question.
- In read-only mode a person fixes Bitrix and **replies "done"** to the
  question; Wenze re-reads Bitrix at once, **confirms** and asks the next — or
  says what is still different. "skip" brings it back tomorrow and asks the
  next at once.
- **Since 11 November 2026 every question says what to do**: a plain
  recommendation (💡) and, when the bot can do the fix itself, a **button per
  fix** plus **Skip** — see "Advice and buttons" below.
- A difference of a letter or two, an extra space or the other word order in a
  name is the **same person** and is not asked about. Per word: none in a word
  shorter than four letters ("ALI" and "ALX" are different people), one letter
  in a word of four or five ("JOHN" and "JANE" are two apart, so different), two
  only in a word of six or more; and at most two letters across the whole name
  (`lib/boardBitrix/names.js`).
- Board `HOME` = Bitrix HOME, `SHOP` = SHOP, `VACATION` = VACATION (a driver on
  vacation is not working), every working word = WORKING; a driver not on the
  Board should be TERMINATED / LEFT / RESIGNED. A Bitrix `NEW` with no Board line
  is a difference too.
- The status is compared as well as the driver and the truck.

Since 9 November 2026 the application discovers the current Bitrix catalogue on
every pass. Exact live labels are resolved deterministically. If an operator
renamed a pipeline, field or stage, AI may classify **catalogue labels, opaque
ids, safe field/stage metadata and aggregate item counts only** — never
driver/deal/Board data. Field metadata is limited to type, multiplicity, CRM
relation targets and enum labels from the closed fleet vocabulary; all deal fields are included up to a
fail-closed bound, so a custom field cannot disappear merely because it was
later in a large catalogue. Every
selected id must be one returned by the same live Bitrix read and confidence
must be at least 85. The aggregate evidence is just category/stage totals from
`crm.item.list`; titles, assigned drivers and other item fields are not read for
schema discovery.

Since 10 November 2026 a plausible result is first stored as a candidate, not
used by the comparison. It must be seen on two matching complete reads. A
pipeline/process/category/field change, or a large change from the proven
active-truck count, remains pending for explicit administrator approval even
after the second read. A selected populated category with zero selected active
trucks is invalid, not a candidate. Promotion preserves no old write authority:
it replaces the last-known-good mapping and resets status sync to `off`. The
settings card shows catalogue labels and counts, never driver/deal/truck data.
Failure/candidate detail stays off the shared public health summary.

Some Bitrix portals expose the truck pipeline and custom stages with opaque
codes as their labels. AI must refuse to invent meanings for those. On the
safe historical bootstrap, code may match the October last-known ids when the
live process is still exactly entity `1040`, category `17` and all three known
active-stage ids are returned in that category with current items. That result
is always anomalous: it must repeat on two complete reads and then an
administrator must explicitly approve it. Once approved, it is reused only
while every id, the non-zero aggregate evidence and the selected live-catalogue
fingerprint remain valid. If an applicable field/category/stage is added,
removed or renamed, the active mapping is not reused and current-catalogue AI
discovery runs.

### A stage is its STATUS_ID — never the row's ID (10 November 2026)

`crm.status.list` answers every stage with two identifiers: `ID`, the row's
number in Bitrix's status table (`"703"`), and `STATUS_ID`, the stage itself —
what a deal carries in `STAGE_ID` and a truck item in `stageId`
(`C3:UC_XZ955I`, `DT1040_17:UC_90RJVZ`). The schema code read `ID` as the
stage from 9 November, and its tests agreed because their fixtures put the
code in `ID`. In production the catalogue ("703") and the truck counts
(`DT1040_17:…`) never met:

- the historical bootstrap could not find stage `DT1040_17:UC_90RJVZ` (104
  trucks) in the catalogue, so the schema stayed blocked with "missing Trucks
  pipeline, active-truck stages";
- the model was shown every truck stage with 0 trucks, so every answer was
  refused;
- the 9 November `ai_validated` schema saved driver stages as `"711"`, `"703"`…
  and truck stages as `"1087"`…; the one comparison it ran filed 104 false
  "status differs" and 94 false "truck inactive" questions, and a live sync
  would have written `STAGE_ID: "703"` into deals. None was written
  (`board_bitrix_stage_sync_actions` was empty; sync was `off`).

So (`lib/boardBitrix/stageCodes.js`): every stage row is turned into
`{ id: STATUS_ID, name, sort, semantics }` the moment it is read, and a row
without `STATUS_ID` makes the read incomplete — the pass stays blocked. A
mapping whose driver stage is not `C{pipeline}:…` or whose truck stage is not
`DT{process}_{category}:…` — a row number above all — never validates. A
Trucks process with exactly one pipeline uses it whatever it is called
("Default pipeline"); two or more with no matching label stay unresolved. A
historical-bootstrap refusal says which check failed ("Bitrix no longer lists
the previously verified truck stage(s) …"), and the settings card lists the
three previously verified stages: their live names, whether Bitrix still lists
them, and their truck counts. A custom field's `title` is only its code, so its
label is `formLabel` / `listLabel`. Every discovery test answers
`crm.status.list` in the real shape (`tests/helpers/bitrixStatusRows.js`).

## Where Bitrix keeps drivers and trucks

Read from the portal on 29 October 2026 by the owner's Bitrix agent. These are
the fallback names and ids; `services/boardBitrix/schemaDiscovery.js` resolves
the current catalogue before every pass.

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

- **Read-only is the default, and the write boundary is one field.** The check
  itself and `sync_mode` both default off. `services/boardBitrix/bitrixRead.js`
  still only lists deals and truck items. An administrator must first turn on
  the check, obtain a dynamically validated schema, and explicitly confirm
  `live`; `dry_run` records the exact transitions and never calls a Bitrix
  mutation. The live writer's only mutation is `crm.deal.update` with
  `{ fields: { STAGE_ID } }`. It cannot edit a name, truck, driver type, deal,
  pipeline, field, or Board row.
- **AI interprets catalogue structure; deterministic code authorizes use.**
  Exact catalogue labels win. AI receives no driver names, deal ids, truck
  numbers/titles, Board statuses or Board rows. It may choose only ids in the
  supplied catalogue, sees safe schema metadata plus aggregate category/stage
  item counts, and needs confidence ≥85. A unique Trucks relation and a unique
  company/owner-operator/lease enum are resolved deterministically before AI.
  `lib/boardBitrix/schema.js` independently validates the
  pipeline, smart process, fields, stage category and four different
  HOME/VACATION/SHOP/WORKING stages. `schemaEvidence.js` independently proves
  that the chosen category and active stages contain current items. That proof
  is also the validator for **each model attempt**: an overconfident answer
  selecting empty or cross-category stages is rejected inside the AI router so
  the next eligible model is asked; it is not accepted and rejected only after
  routing has stopped. If none answers validly, the pass stays blocked and the
  settings card shows populated catalogue stage labels/counts only. AI is
  absent from `stageSync.js` and cannot call a mutation.
- **Opaque labels are never guessed.** A match to the historical Trucks ids is
  allowed only under the exact live-process/category/stage/count proof above,
  and unlike an ordinary candidate it can never auto-promote after two reads:
  an administrator must approve it. Approval still resets sync to `off`.
- **A newly interpreted schema cannot affect the first pass.** It lives in
  `board_bitrix_schema_candidates`, must have the same fingerprint on two
  complete reads, and until promotion the pass stops before comparing, changing
  the queue, asking or syncing. A structural change or implausible count needs
  an administrator after those two reads. Invalid discovery never overwrites
  the last-known-good mapping. Every promotion — automatic or approved — resets
  `sync_mode` to `off`; live must be explicitly confirmed again.
- **A fuzzy comparison is never identity proof for a write.** The comparison
  keeps the owner's typo tolerance so it does not create noisy questions. The
  writer separately requires a strict name match and the same known fleet plus
  the **exact normalized unit spelling**. `001` and `1` may be treated as the
  same seat for a question, but are not enough for an automatic update. A
  missing/ambiguous fact leaves the status discrepancy in the human queue.
- **Every status event settles for 20 minutes.** Immediately before writing,
  the worker re-reads the exact `dispatch_board_rows` event (row key, status and
  `status_changed_at`) and `crm.deal.get`; it refuses when the Board changed,
  the deal moved, changed pipeline or closed. It also re-reads the live kill
  switch immediately before the mutation, then verifies the target stage with
  another `crm.deal.get`.
- **No mass update and no duplicate update.** More candidates than the
  configured per-pass limit (1–25, default 10) blocks the whole pass. A durable
  database claim makes each Board event/deal transition idempotent across
  processes; applied transitions are terminal and every planned/applied/failed
  action is audited. If a robot later reverses an applied stage, Wenze asks a
  person instead of looping forever.
- **Nothing is decided from an incomplete read.** The pass stops before the
  queue is touched when the check or the Board feed is off (`blocked`), Bitrix
  is not connected (`blocked`), the Board's last successful read is older than
  **max(30 minutes, 2 × its poll interval + 5 minutes)** (`boardFreshnessMs` —
  30 minutes at the default 5-minute interval, 125 minutes at the slowest
  hour), the Board snapshot names nobody or may be cut off (5 000 lines),
  Bitrix returns no active driver, any page fails, an ACTIVE list (drivers,
  trucks) is longer than one pass reads (2 000), a field the comparison needs no
  longer comes back, or the Trucks list holds none of the trucks the active
  drivers point at (`error`). Resolving or
  asking from half a list would call every driver on the missing pages "not in
  Bitrix".
- **Schema evidence is complete or the pass stops.** The schema reader pages
  through at most 2 000 truck items and keeps category/stage counts only. It
  rejects a candidate when its chosen category has no current items, when a
  populated chosen category has zero items in the chosen active stages, or
  when an id belongs to another category. Crossing the count anomaly threshold
  (less than half the last-known-good active count, or more than 1.5× plus 10)
  cannot auto-promote. The 9 November production failure shape — 104 trucks in
  Bitrix but AI-selected active stages counting 0 — therefore blocks before it
  can turn 45 real differences into hundreds of false questions.
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
- **Only the people allowed are listened to**: the control channel's
  operators (`control_operators`) and, since 11 November 2026, the Telegram
  ids typed in Settings → Dispatcher Board → "Who may answer the questions"
  (`board_bitrix_settings.responder_ids`, migration 0102). Until then only the
  owner counted, and a teammate's "done" / "skip" was silently ignored —
  which is why a "skip" once asked no next question. A stranger's reply or tap
  is consumed and never acted on. A redelivered Telegram reply is claimed
  once per question (`claimReply`). The handler sits right after the learning
  questions' handler (`tests/boardBitrixReply.test.js` asserts the order).
- **"done" / "skip" are read by rules** in English or Russian
  (`lib/boardBitrix/replyIntent.js`); **any negation makes a reply unclear**
  ("haven't fixed it yet", "не всё готово") — never "done". **Anything else is
  read by a model** with the question's facts (`readReplyWithAi`): it may be
  done, skip, "do fix N" (the same as tapping it), or information, which the
  bot answers in a sentence — "they are a team" → "then the Board is missing
  her as the team driver". With no model it gets the one line saying what to
  type.
- **A "done" that the timer's pass beat to it says nothing more**: the pass has
  already said "Fixed" under the question and asked the next; a second
  confirmation would arrive after the next question.
- **Advice and buttons** (owner, 11 November 2026). The fixes the bot can do
  are built BY RULES from the difference (`lib/boardBitrix/actions.js`, the
  Board being the truth): move the deal to the stage the Board's status maps
  to, close a deal not on the Board (its pipeline's closing stages, by their
  Bitrix names — TERMINATED / LEFT / RESIGNED), rename the deal to the Board's
  name, set its driver type, point it at the Board's truck, or move a truck to
  "On the road". A model (`board_bitrix_advice`, `services/boardBitrix/
  advice.js`) **sees everything about the question** — the difference, the
  Board lines on the same truck or with a similar name, the deal (owner, 11
  November 2026) — writes the recommendation and CHOOSES which fixes get a
  button; it cannot add one, and an index it names that is not offered is
  dropped. No model: every rule-built fix, no recommendation. The advice is
  stored with the question (`advice_json`), so a tap means exactly what it
  showed; a reminder keeps it, a question asked again is advised again.
- **A tap writes only after Bitrix is read again** (`services/boardBitrix/
  apply.js`): each fix carries where Bitrix stood when it was offered, and a
  deal or truck changed meanwhile is refused ("changed meanwhile") with
  nothing written. One write per tap — `crm.deal.update` with that one field
  (`STAGE_ID`, `TITLE`, the driver-type or truck field) or `crm.item.update`
  with a truck's stage — and only with a **validated** schema (never the
  static fallback). Then the same re-check as "done". The owner allowed these
  writes on 11 November 2026 ("if it is something I do not want, I answer
  skip"); the guarded automatic status sync below is unchanged.
- **The questions carry no `question_json`**, so the control channel's buttons,
  standing cap, daily budget and morning summary never touch them — the same
  arrangement as the AI learning questions (`docs/architecture/ai-learning.md`).
- **Counts only on the settings card.** No driver name and no truck number on
  Settings → Dispatcher Board; those are in the question in the group.
- **Passes never overlap** (`runExclusive`): the 15-minute timer and the
  re-check after "done" queue behind each other in this process.
- **Off until switched on** (`board_bitrix_settings.enabled` defaults FALSE), so
  a deploy asks nobody anything by itself. Switching on runs a pass at once.
  Switching the check off also resets `sync_mode` to `off`; turning the check
  on later can never silently restore an old live-write permission.
- **Stood down in economy mode** with the other automatic checks and the
  questions they raise (`lib/operations/economyMode.js`): no pass, no new
  question, no reminder; while paused, "done" is answered with "could not
  check". **"skip" is the one thing still honoured** — it is the owner's own
  action, reads nothing and asks nothing: the question is put off for a day and
  no next question goes out until economy mode ends.
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
| `database/migrations/0098_board_bitrix_status_sync.sql` | sync mode, last-known-good schema record and the idempotent `board_bitrix_stage_sync_actions` audit |
| `database/migrations/0099_board_bitrix_schema_candidates.sql` | catalogue/count-only candidate or invalid discovery; never driver/deal/Board data |
| `lib/boardBitrix/` | pure: `vocabulary` (read-only fallback), `stageCodes` (a stage is its STATUS_ID), `schema` (live-catalogue validation), `schemaEvidence` (aggregate proof), `schemaCandidate` (two-pass/approval rule), `names`, `trucks`, `compare`, `wording`, `replyIntent` |
| `services/boardBitrix/bitrixRead.js` | the two list reads, complete or failed |
| `services/boardBitrix/schemaDiscovery.js`, `schemaAi.js` | exact live schema discovery; bounded AI interpretation of catalogue labels/opaque ids, safe schema metadata and aggregate counts only |
| `services/boardBitrix/stageSync.js` | dry-run/live status plan, strict identity guard, fresh Board/deal checks, the only `STAGE_ID` write |
| `services/boardBitrix/pass.js`, `timer.js` | one pass; the 15-minute timer, `board_bitrix_check` in the roster |
| `services/boardBitrix/ask.js`, `reply.js` | one question at a time, with its advice and buttons; "done" / "skip" / own words |
| `lib/boardBitrix/actions.js`, `services/boardBitrix/advice.js` | the rule-built fixes; the model's recommendation and choice; reading a reply in own words |
| `services/boardBitrix/answer.js`, `buttons.js`, `apply.js` | who may answer, skip / done / do a fix (shared by replies and taps); the tap; the one write, after a fresh read |
| `database/boardBitrixAdvice.js`, migration 0102 | who may answer; the advice a question showed; a notice's own buttons (`reply_markup_json`) |
| `database/boardBitrix.js` | the switch, the one-transaction pass, the queue |
| `database/boardBitrixSchema.js` | locked last-known-good refresh, candidate observation/promotion and explicit approval |
| `bot/handlers/boardBitrixReplyHandlers.js`, `boardBitrixButtonHandlers.js` | register the reply handler and the buttons (`bbx:<question>:<fix or s>`) |
| `services/boardBitrix/admin.js`, `server/routes/settings/boardBitrixRoutes.js` | `GET /board-bitrix`, `PUT /board-bitrix/enabled`, `PUT /board-bitrix/sync`, `PUT /board-bitrix/responders`, `POST /board-bitrix/run`, `POST /board-bitrix/schema/approve` under `/api/settings` |
| `admin/src/pages/settings/dispatcherBoard/BoardBitrixCard.jsx` | the card under the Feed card |

## Tests

```
node --test tests/boardBitrixNames.test.js tests/boardBitrixCompare.test.js tests/boardBitrixPass.test.js tests/boardBitrixSync.test.js tests/boardBitrixReply.test.js tests/boardBitrixAdmin.test.js tests/boardBitrixAdvice.test.js
node --test tests/boardBitrixSchemaBootstrap.test.js tests/boardBitrixStageCodes.test.js   # production-shaped catalogue
TEST_DATABASE_URL=… node --test tests/boardBitrixPg.test.js
npm test --prefix admin -- --run src/pages/settings/dispatcherBoard/BoardBitrixCard.test.jsx
```
