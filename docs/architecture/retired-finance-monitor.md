# The Finance Monitor (money codes), and what is left of it

**Retired:** 2026-10-23, at the owner's request — the Finance Monitor is removed
entirely. · **Pre-removal source:** any `main` commit before this removal
merged; the code is recoverable with
`git log --diff-filter=D -- services/finance/captureService.js`.

The Finance Monitor read the finance Telegram group, where money codes are
issued, and kept a ledger of them. Off by default and switched on per group in
**Settings → Finance**, it stored every message of that group verbatim
(`finance_messages`), read the money code, amount and reference out of each one
with a label-based parser, and recorded each code it read with certainty
(`finance_moneycodes`) — with a duplicate recorded beside it, never acted on.
Voids and replacements were read from later messages ("voided", "replacement
for …") and kept as an append-only event trail (`finance_moneycode_events`).
Attachments (receipts, invoices, transfer screenshots) were queued
(`finance_documents`) and read one at a time by a background reader, a PDF's
text layer first and a model's vision otherwise. Messages the rules could not
settle were offered once to a model for their MEANING, never their numbers; a
re-read pass ran each parser upgrade over what was already captured; and a
weekly money-code summary went out every Monday 08:00 America/Chicago
(`finance_reports`). The Finance page under Operations listed the messages,
codes, attachments and summaries.

This file replaces `docs/architecture/finance-monitor.md`,
`finance-monitor-page.md` and `finance-moneycode-reading.md`, which described
the capture gate, the parser, the void and replacement rules, the document
reader, the weekly report and the page. All of that went with the feature; what
is still true about the tables it wrote is below.

## What was removed

| | |
|---|---|
| `bot/handlers/financeCaptureHandlers.js` | the observer registered after the group capture pipeline; `bot/bot.js` no longer registers it, and no message of any group is read for money codes |
| `services/finance/*` | capture, the document reader, the void and replacement services, the AI interpretation, the re-read pass and the weekly report |
| `lib/finance/*` | the money-code parser (`moneycode/*`), duplicates, void intent and target, replacement, phrasing, the document policy and prompt, the AI-reading verifier, the weekly schedule and the report's words |
| `database/financeSettings.js`, `financeMessages.js`, `financeDocuments.js`, `financeMoneycodeLifecycle.js`, `database/finance/reports.js` | the stores |
| `server/routes/financeRoutes.js` | `/api/finance/*` (messages, money codes and their events, documents, reports, re-read, retry, preview, send-now) answers 404 like any unknown API path |
| `server/routes/settings/financeRoutes.js` | `/api/settings/finance*` (settings, status, validate-chat) answers 404 |
| Admin: Operations → Finance Monitor (`admin/src/pages/FinancePage.jsx`, `admin/src/pages/finance/*`), Settings → Finance (`admin/src/pages/settings/FinanceTab.jsx`), `admin/src/api/finance.js`, `admin/src/api/financePage.js` | the `finance` and `settings_finance` page keys and sidebar entries, the Settings tab key `finance`; thirteen functions off the admin's public surface — the `apiFacade` floor is now 212 |
| Background services `finance_document_reader`, `finance_weekly_report`, `finance_reparse` | gone from `lib/operations/backgroundServiceCatalog.js`, the roster in `services/backgroundServices.js` and the scheduler's hourly tick. None was ever on the economy-mode pause list; `tests/economyMode.test.js` no longer names them as kept |
| AI capabilities `finance_message_reading`, `finance_document_extraction` | gone from `lib/ai/capabilityCatalog.js` and [`ai-decisions.md`](ai-decisions.md) |
| Notification category `finance` | gone from `lib/notifications/categories.js` and its icon from `services/notifications/send.js`. A `finance` key already saved in `operational_notification_settings.category_chat_ids` routes nothing and is harmless; the next save of a routing map that names it is refused as an unknown category, the same as `fuel` |
| The `financeDocuments` block of `/api/health` | `server/routes/healthRoutes.js` no longer reads the document queue |
| Following `finance_settings.chat_id` and `weekly_report_chat_id` on a group upgrade | removed from `lib/telegram/chatMigration.js` and the cache list in `services/telegramChatMigration.js`; `tests/telegramChatMigration.test.js` lists both columns in `NOT_DESTINATIONS` |
| `services/documents/pdfTextExtraction.js` and `lib/telegram/fileDescriptor.js` | their last users were the finance reader and capture. `pdf-parse` stays (the Indeed lead import reads it directly) |
| `tesseract.js` and the committed `eng.traineddata` | the OCR branch of `pdfTextExtraction` was the only user, and no caller had asked for it since the pinned-load reading went (2026-10-23). Removed from `package.json` / `package-lock.json`, and the file-size scanner's exclusion for the model went with the file |
| Environment `FINANCE_GROUP_CHAT_ID` | was read by `database/financeSettings.js` only, and never listed in `.env.example`. A host that still sets it is unaffected; it can be deleted |
| Their tests | every `tests/finance*.test.js` (parser, duplicates, void, replacement, capture, handler, documents, reader, schedule, weekly report, page, settings, and the `*Pg` ones), `healthFinanceQueue`, `pdfTextExtraction`; the `finance documents may be read by AI` case of `ownerSettings20261006Pg` |

## What stayed, and why

- **The Telegram file download.** `services/finance/telegramFileDownload.js`
  was never finance-specific: Safety Approvals reads the photo or document a
  post carries through it. It moved to `services/telegram/fileDownload.js` as
  `downloadTelegramFile` / `TelegramDownloadError`, unchanged in behaviour —
  the URL that embeds the bot token is still never logged, stored or put in an
  error, and the size is still refused before and during the transfer
  (`tests/telegramFileDownload.test.js`, formerly `financeDocumentDownload`).
- **The admin's HTTP funnel** (`admin/src/api/http.js`) still accepts `message`
  as well as `error` in a 4xx body. The Finance settings routes were the reason
  it learned to; the fallback is general and stays.
- **The tables.** `finance_settings`, `finance_messages`, `finance_moneycodes`,
  `finance_moneycode_events`, `finance_documents` and `finance_reports` are read
  and written by nothing. **They are the only record of which money codes were
  posted in the finance group, when, and which were voided** — so they stay on a
  deployed database until an administrator drops them from **Settings → Retired
  feature leftovers** (group `finance`, *Finance Monitor (money codes)*) after a
  backup. Payment data: export first if the record may ever be asked for.
  - They were never in the boot baseline: migrations 0052, 0053, 0054 and 0057
    created them and migration 0066 set `ai_reading_enabled`. A deployed
    database never re-runs a migration, so a drop stays done, and no
    fresh-database stub was needed — on a brand-new database the migrations
    create them once, as leftovers from the start.
  - The drop needs no `CASCADE`: every foreign key is between finance tables
    (including `finance_moneycodes` → itself), and the cleanup drops the keys
    inside the set first. `tests/retiredLeftoversPg.test.js` builds the tables
    from those exact migrations, with rows, and proves it.
  - `docs/database/table-metadata.json` marks all six `retired`.
- **The weekly report's claims** in `service_runs` (`service_name =
  'finance_weekly_report'`, one row per reported week) are history and tiny;
  nothing reads them. They were left alone.
- **The stale health rows.** Migration 0082 deletes the `finance_document_reader`,
  `finance_weekly_report` and `finance_reparse` rows from `system_health_states`
  and `background_service_runs`; nothing writes them any more, and the health
  screen must not keep calling them `ok` or "waiting to be switched on".

No RBAC data changed: the Finance page and its settings were behind the same
admin gate as every other settings screen, and no finance permission key or
role ever existed, so there is nothing for the leftovers cleanup to purge.

## Tests that hold this in place

```
node --test tests/removedFeaturesStayRemoved.test.js  # modules, imports, handler, workers, routers, capabilities, category, tesseract
node --test tests/api-surface.test.js                # /api/finance/* and /api/settings/finance/* → 404 WITH a valid token
node --test tests/retiredLeftovers.test.js           # finance is droppable and not recreated on boot
node --test tests/telegramChatMigration.test.js      # the finance chat columns are explained, not followed
node --test tests/telegramFileDownload.test.js       # the moved download: no token in any error, the cap holds
TEST_DATABASE_URL=… node --test tests/retiredLeftoversPg.test.js  # built by the real migrations, dropped, stays dropped
npm test --prefix admin -- --run apiFacade
```
