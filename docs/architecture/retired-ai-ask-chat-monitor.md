# Retired features: "Ask the Data" & "Chat Monitor"

Both admin features were **hidden but still shipping** (frontend bundle, backend
routes, a 10-second polling timer). They have now been **fully removed** from the
runtime, frontend bundle, and backend routes. No shared infrastructure used by
active features was removed. This document records exactly what changed.

---

## 1. "🔍 Ask the Data" — removed completely

Natural-language question → whitelisted JSON query plan → server-compiled SQL →
narrative answer. It was the *only* consumer of `aiAskService.js`.

### Removed
| Kind | Item |
|---|---|
| Frontend page | `admin/src/pages/AskDataPanel.jsx` (deleted) |
| Frontend nav/route | `ask_data` entry in `admin/src/App.jsx` (import, `pages` map, "Insights" nav item) |
| API client | `askTheData()` in `admin/src/api.js` |
| Backend route | `POST /api/ai-ask` in `server/api.js` |
| Backend service | `services/aiAskService.js` (deleted — `askData`, `compilePlan`, `parsePlan`, `buildMessageLink`) |
| Backend import | `const { askData } = require('../services/aiAskService')` in `server/api.js` |
| Tests | `tests/aiAsk.test.js` (deleted) |
| Dev script | Removed the `POST /api/ai-ask` section from `scripts/e2e-ai-insights-live.js` |
| Dead helper | `humanizeColumn()` in `admin/src/utils/formatTime.js` (was only used by AskDataPanel) |
| Docs | `docs/architecture/module-map.md` and `docs/deployment/pre-deploy-checklist.md` (H1–H3) updated to drop Ask-the-Data references |
| Comments/env wording | `services/groqClient.js` consumer list; "Ask Data" wording in `.env.example` and `README.md` |

### Preserved (shared — do NOT confuse with Ask-the-Data)
- `services/groqClient.js` / `services/geminiClient.js` — shared LLM clients used
  by AI insights, annotation, analysis, dispatch parsing, DAT inspector.
- `services/aiInsightsService.js`, `services/aiAnnotationService.js`,
  `services/aiAnalysisService.js`, `services/insightRenderer.js` — management
  insights pipeline (active).
- The `v_annotated_messages` view and `chat_message_annotations` table — used by
  the insights pipeline.

**Backend endpoint result:** `POST /api/ai-ask` no longer exists → Express
returns **404**.

---

## 2. "💬 Chat Monitor" — removed completely (shared storage preserved)

A live table of recent driver-group messages that **auto-refreshed every 10s**.

### Removed
| Kind | Item |
|---|---|
| Frontend page | `admin/src/pages/ChatLogsPage.jsx` (deleted — this held the 10s `setInterval`) |
| Frontend nav/route | `chat_logs` entry in `admin/src/App.jsx` (import, `pages` map, "Insights" nav item) |
| API client | `getChatLogs()` in `admin/src/api.js` |
| Backend route | `GET /api/chat-logs` in `server/api.js` |
| Backend DB fn | `getRecentChatLogs()` in `database/db.js` (+ its export) — was only called by the chat-logs route |
| Stray comment | Leftover `// Chat Logs Page` divider in `admin/src/pages/QuestionsPage.jsx` |

The whole "Insights" navigation section (which contained only these two items)
was removed from the sidebar.

### Database / storage — NOTHING dropped, and here is why

The `chat_logs` table is **shared** and still required by active features:

| Consumer | Function | Feature |
|---|---|---|
| `services/dispatchPinnedContextService.js` | `db.getChatLogsForGroup` | Dispatch Center load context |
| `server/api.js` AI reports route | `db.getChatLogsForActiveDriverGroups`, `db.getChatLogsForGroup` | AI reports |
| `services/aiAnnotationService.js`, `services/aiInsightsService.js` | direct `chat_logs` reads | AI management insights |
| `services/schedulerService.js` | `db.deleteOldChatLogs(30)` | 30-day retention (hourly) |

Because `chat_logs` powers Dispatch Center + AI Insights, **the table was NOT
dropped** and its shared read/retention functions were **kept**. Only the
Chat-Monitor-exclusive read (`getRecentChatLogs`) and the UI/API were removed.

**No new storage growth:** message-level writes to `chat_logs` from the bot were
**already disabled** before this change (see the comment at `bot/bot.js`:
*"General message logging is intentionally disabled: we no longer persist every
group message to chat_logs."*). The unused writer `db.logChatMessage` was left in
place (it is the generic shared writer, not Chat-Monitor-specific) but nothing
calls it, so Chat Monitor's removal adds **zero** ongoing storage. The existing
30-day retention job continues to bound the table.

**No migration required.** Nothing is dropped, so there is no data-destroying
migration and no export/backup step is needed. If the owner later wants to reduce
`chat_logs` further, that is a separate decision that must account for Dispatch
Center and AI Insights first.

**Backend endpoint result:** `GET /api/chat-logs` no longer exists → Express
returns **404**. No polling timer remains anywhere in the frontend.

---

## 3. Runtime-memory / bundle verification

- Frontend bundle: `AskDataPanel` and `ChatLogsPage` are no longer imported by
  `App.jsx`, so Vite tree-shakes them out of the production build.
- No `setInterval` for chat logs remains (the only one lived in the deleted
  `ChatLogsPage.jsx`).
- No backend route, handler, or query for either feature remains.
- Full backend test suite passes; admin production build succeeds.
