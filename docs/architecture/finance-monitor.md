# The Finance Monitor

**Read this before changing anything under `lib/finance/`,
`services/finance/`, `database/finance*`, `bot/handlers/financeCaptureHandlers.js`
or `server/routes/settings/financeRoutes.js`.**

Money codes are issued in a Telegram group and then exist nowhere else. There is
no ledger, so *"did we already send that one?"* and *"what went out last week?"*
are answered by scrolling. This feature gives those two questions an answer.

It reads a payment chat. Every rule below exists because of that.

---

## 1. Off by default, and off means off

`finance_settings` ships with `enabled = FALSE` and `chat_id = NULL`. Nothing is
read from any chat until a person switches it on in **Settings → Finance
Monitor**, and they cannot switch it on until a group has been **validated** —
the bot has been asked whether it can see that chat and whether it is a group.

The rule is enforced in three places, deliberately:

| Where | What it does |
|---|---|
| `database/financeSettings.js` `updateFinanceSettings` | throws `FinanceSettingsError` when `enabled` is set without `chat_id` **and** `chat_validated_at` |
| `server/routes/settings/financeRoutes.js` | re-validates a `chatId` arriving in a PUT, so the button cannot be routed around |
| `admin/src/pages/settings/FinanceTab.jsx` | the checkbox is disabled until the chat in the form has been proved |

Three guards for one rule is not an accident. The admin one is a courtesy, the
route one stops a hand-written request, and the store one is the only one a
future caller cannot skip.

`chat_id` NULL inherits `FINANCE_GROUP_CHAT_ID`, the house rule for every
settings column. **`enabled` inherits nothing.** An environment variable must
never be able to start reading a payment chat.

Validation goes through `services/telegramChatIdCheck.js`, the same check that
exists because `5052301861` (the real chat was `-5052301861`) once saved cleanly
and then failed forever. A dropped minus sign here would mean capturing a
stranger's chat, or capturing nothing.

---

## 2. Capture first, codify second — and the schema enforces the order

`finance_messages.text` **is the record.** Everything the parser concluded is
written *beside* it — `parse_status`, `parse_json`, `parser_version` — and never
instead of it.

That is not tidiness. **Nobody has shown the parser a real message.**
`lib/finance/moneycode.js` says so in its own header, and `PARSER_VERSION = 1`
is there so a tightened parser can re-read exactly the rows the provisional one
produced. Overwriting the text with an interpretation would make that impossible,
permanently — the evidence would be gone and only the guess would remain.

`parse_status` has four values, and `ambiguous` is one of them **on purpose**:

| Status | What it means |
|---|---|
| `not_moneycode` | ordinary chat — no money words at all |
| `unparsed` | money words, but no code this parser can read |
| `ambiguous` | more than one candidate; the parser refuses to pick |
| `parsed` | one code, read with certainty |

A parser refusing to pick is an answer, not a failure, and it is shown on the
settings screen as its own number rather than folded into a failure total —
because `ambiguous` and `unparsed` are the input for tightening it.

**Only a `parsed` message produces a `finance_moneycodes` row.** Inventing a row
from a message nobody could read is exactly the guess this feature refuses.

---

## 3. A duplicate is recorded, never acted on

Wenze does not issue money codes and cannot recall one. The strongest thing it
does is write `duplicate_of_id` and a **reason**, so a person reading the list
can see it.

The two reasons stay apart because they are different claims
(`lib/finance/duplicates.js`):

- **`same_code`** is a *fact*. A code is what gets spent; the same code posted
  twice is the same code, whenever it happened. The candidate query therefore
  matches an exact code with **no time window at all**.
- **`same_amount_recipient_window`** is a *suspicion*. Two $500 advances to one
  driver in a day is sometimes exactly right. It is only ever raised inside
  `duplicate_window_hours` (default 72, settable 1–8760).

The weekly report (D3) has to be able to say *"one code posted twice"* without
implying *"paid twice"*, so the two are never collapsed into a boolean. Paired
CHECKs in migration 0052 refuse a row that names a reason without the row it
points at, or a row that claims to repeat itself.

---

## 4. Capture is an observer, and it cannot take the bot down

`bot/handlers/financeCaptureHandlers.js` is registered in `startBot()` **after**
`registerGroupCaptureHandlers` and **before** `registerControlReplyHandlers`.

- **After** the capture pipeline, so ordinary group handling — migration, pinned
  snapshots, home time, fuel, the chat buffer — is entirely unchanged. A finance
  group that is also a driver group, which nobody has forbidden, must not lose
  its other handling because this one looked first.
- **Before** the control channel, so a finance message is stored before anything
  downstream can consume it.

**`next()` is called on every path, including the failing ones.** Capture never
consumes a message.

**It cannot throw.** `index.js` installs an `unhandledRejection` hook that calls
`process.exit(1)`, so a rejection escaping a `bot.on('message')` handler stops
the whole application. `captureFinanceMessage` returns a reason instead of
throwing, and the handler adds a `try/catch` on top of that. A payment log is not
worth the bot.

The handler holds **no chat id, no parser and no query** — every decision lives
in `services/finance/captureService.js` where it can be tested without a bot.
`tests/financeCaptureHandler.test.js` asserts that structurally, so a gate that
grows back into the handler fails the suite.

Edited messages are captured too. An edit is what the group now says, and a money
code corrected after the fact is exactly the case a ledger exists for. An edit of
a message that was never captured — posted before the monitor was switched on —
creates nothing.

---

## 5. Idempotency belongs to the database

Telegram redelivers, and a restart replays. `captureMessage` inserts with
`ON CONFLICT (chat_id, message_id) DO NOTHING` and reports `{ id, created }`;
`recordMoneycode` does the same on `(message_ref_id, code_normalized)`.

A check-then-insert would be a race two handlers could both win. A unique index
is not. `tests/financeCapturePg.test.js` proves both against the real schema.

---

## 6. Payment text lives in exactly one place

`finance_messages.text` is that place.

- **Nothing logs message text.** The capture service and the handler log chat
  ids, message ids and statuses only. Copying payment messages into the
  application log would undo the whole point of the table.
- **The settings API answers with counts.** `GET /api/settings/finance/status`
  returns a status histogram and three totals — no text, no code, no sender.
  `tests/financeSettingsRoute.test.js` asserts that structurally rather than by
  spot-check, so the shape can grow without leaking.
- Rows themselves get a screen in **Stage D4** (`server/routes/financeRoutes.js`),
  behind its own permission. That is the one place text is meant to leave the
  database.

---

## 7. A database outage is not "nothing configured"

`database/financeSettings.js` treats **only** `42P01` (undefined_table) as
"not set up yet" — a brand-new database before `initializeDatabase()` ran.
Everything else is rethrown.

Six older settings modules used to catch every error and return `null`, which
turned a transient outage into "the operator switched this off". They were fixed
in the same spirit; see `APP_BRIEF.md` §9 — *a failure is never rendered as
empty data* — and `lib/database/failureClassification.js` for the vocabulary.

`captureFinanceMessage` therefore distinguishes `'settings unavailable'` from
`'not the finance chat'`. They look identical from outside and mean opposite
things.

---

## 8. Where each piece lives

| Layer | Module |
|---|---|
| Pure | `lib/finance/moneycode.js` — `parseMoneycodeMessage`, `PARSER_VERSION`, `STATUS` |
| Pure | `lib/finance/duplicates.js` — `decideDuplicate`, `REASON`, `normalisePerson` |
| Schema | `database/migrations/0052_finance_monitor_capture.sql` |
| Store | `database/financeSettings.js`, `database/financeMessages.js` |
| Service | `services/finance/captureService.js` |
| Bot | `bot/handlers/financeCaptureHandlers.js` |
| API | `server/routes/settings/financeRoutes.js` (mounted at `/api/settings`) |
| Admin | `admin/src/pages/settings/FinanceTab.jsx`, `admin/src/api/finance.js` |

Dependencies flow one way, as everywhere else: route → service → store → `lib/`.

---

## 9. The tests that guard this

```
node --test tests/financeMoneycodeParser.test.js     # every status, from synthetic fixtures
node --test tests/financeDuplicates.test.js          # fact vs suspicion, and the window
node --test tests/financeCaptureService.test.js      # the gate, and what it never throws
node --test tests/financeCaptureHandler.test.js      # observer, position, cannot kill the bot
node --test tests/financeSettingsRoute.test.js       # the enable guard, counts only
TEST_DATABASE_URL=… node --test tests/financeSettingsPg.test.js tests/financeCapturePg.test.js
npm test --prefix admin                              # FinanceTab: the checkbox is the guard
```

---

## 10. What is deliberately NOT here yet

- **The parser is provisional.** It is tightened from real captures, in its own
  PR, with `PARSER_VERSION` bumped — never by editing rows.
- **Documents** (`capture_documents`, `max_document_mb`, `ai_reading_enabled`)
  have columns and no reader yet. Stage D2 adds the sequential background
  reader; until then the columns are inert and the settings screen does not
  offer them.
- **The weekly report** (`weekly_report_enabled`, `weekly_report_chat_id`,
  `enabled_at`) is Stage D3. `enabled_at` is stamped on the first enable and
  never moved, because the report has to tell *"no money codes that week"* from
  *"we were not watching that week"* — opposite answers that would otherwise look
  identical.
- **`finance_moneycodes.issued_to` is left NULL.** Who POSTED a code is recorded;
  who it was FOR is not something this parser can read, and a column filled with
  the sender's name under an "issued to" heading would be worse than an empty
  one.
