# AI Reports / AI Insights, and the admin routes no screen called

**Retired:** 2026-10-30, at the owner's decision after the hidden-functions
audit. · **Pre-removal source:** any `main` commit before this removal merged;
the code is recoverable with
`git log --diff-filter=D -- services/aiAnalysisService.js`.

AI Reports read the driver-group chat log (`chat_logs`) for the last N days and
asked a model (Groq) to write a report about one driver or the whole company.
The report was kept as a draft (`ai_reports`) to be sent to Telegram or
discarded. AI Insights was the newer card-based version: detectors and scores
over the same chats (`ai_insights`, `sender_role_consensus`), a sentence per
card written by a model, cards edited and sent. Both were only ever reachable
through `/api/ai-reports/*` and `/api/ai-insights/*`.

**Why removed.** Their admin screen (`AiFeaturesPage.jsx`) had been gone since
before the oldest commit in this repository's history, so nothing called the
API. And a report sent the model **the whole transcript, with sender names** —
against the owner's October 2026 rule that the AI must not read every driver
message (`driver-retention.md`). Bringing the screen back as it was would have
broken that rule.

## What was removed

| | |
|---|---|
| `server/routes/aiReportsRoutes.js` | `/api/ai-reports` (list, generate, send, discard, test-groq) and `/api/ai-insights/*` (generate, list, read, edit a card, send, annotate) answer 404 like any unknown path |
| `services/aiAnalysisService.js`, `services/aiInsightsService.js`, `services/aiInsights/*`, `services/insightRenderer.js` | the report and insight generators, detectors, scoring, narration and the Telegram rendering |
| `database/aiReports.js` | the reports, insights and sender-role store |
| `database/chatLogs.js` `getChatLogsForGroup`, `getChatLogsForActiveDriverGroups`; `database/groups.js` `getActiveDriverGroupById` | their only caller was the report route |
| `services/aiAnnotationService.js` `ensureAnnotationsForRange` | labelled a date range on demand for a report; nothing else called it |
| `services/telegramHtml.js` `sanitizeCompanyReportHtmlForTelegram` (and its `stripMarkdownCodeFences`) | reduced a report's HTML for Telegram |
| AI capabilities `ai_report_generation`, `ai_insights_narration` | gone from `lib/ai/capabilityCatalog.js` (Settings → AI → Responsibilities) and [`ai-decisions.md`](ai-decisions.md) |
| Admin: `admin/src/api/aiReports.js` (eleven calls) and `sanitizeCompanyReportHtmlForTelegram` in `admin/src/telegramHtmlPreview.js` | Edit by Link's two calls moved to `admin/src/api/messageManager.js` |
| Tests | `aiReports`, `aiInsights`, `aiInsightsUnannotated`, `insightRenderer`, `aiTranscriptFence`, `telegramHtml` |

## Routes with no screen removed in the same change

Each was mounted and protected, and no screen, script or other service called
it (`docs/redesign/structure.md` has the audit). All answer 404.

| Route | What it did | What replaces it |
|---|---|---|
| `GET /api/groups`, `GET /api/groups/driver-list`, `PUT /api/groups/:id/status`, `/language`, `/birthday` | the old group list and direct group writes | the Driver Groups popup saves through `/api/driver-profiles/:id`, which copies language, birthday and status onto the group (`database/driverProfiles.js` `syncGroupFromDriverProfile`); the pickers use `/api/groups/manage` |
| `POST /api/groups/status/run-now` | ran the AI group-status check by hand | the check keeps its schedule (`group_status_ai`, 6:00 and 18:00 Chicago) |
| `POST /api/driver-profiles/ai-parse` | the older AI reading of group titles | `POST /api/driver-profiles/ai-sync` runs the same parser |
| `GET /api/operations/corrections/:id` | one correction with its subject's audit rows | Needs Attention → History lists every correction with its revert |
| `GET /api/recruiting-knowledge/:id/history` | earlier versions of a Teach Wenze entry | the rows are kept; nothing shows them |
| `GET /api/settings/safety-events/music/:id/download` | downloaded an uploaded music clip | — |
| `GET /leads-log`, `GET /retry/:id` (site root) | duplicates of the webhook log and its retry; the retry changed state on a GET | `/api/facebook-leads/webhook-log` and its POST retry (Customer Inquiries → Activity Log). The admin proxy guard (`createProxyAuthGuard`) went with them — they were its only users |

## What stayed, and why

- **The message labelling Driver Retention runs on.**
  `services/aiAnnotationService.js` `annotateChatLogs`, called by
  `services/retention/chatAnnotator.js` (job `chat_annotation`). Only a message
  with a leaving cue reaches a model. `chat_logs` and
  `chat_message_annotations` stay in use.
- **The tables.** `ai_reports`, `ai_insights`, `sender_role_consensus` and the
  view `v_annotated_messages` are read and written by nothing now. They hold
  past reports, so they are left in place (schema changes here are additive);
  `docs/database/table-metadata.json` marks the three tables `retired`.
  Dropping them is a separate decision, after a backup.
- **Database functions left without a caller by the route removals**, kept
  for a later review rather than cleaned up in advance:
  `database/groups.js` `setGroupStatusByAdmin`, `setGroupLanguage`,
  `setGroupBirthday`; `database/operationalCorrections.js` `getCorrectionById`,
  `listAuditForSubject`; `database/recruitingKnowledge.js` `knowledgeHistory`.

## Tests that hold this in place

```
node --test tests/removedAiReportsStayRemoved.test.js  # modules, imports, capabilities, client calls; annotation stayed
node --test tests/api-surface.test.js                  # every removed route → 404 WITH a valid token; live neighbours still answer
```
