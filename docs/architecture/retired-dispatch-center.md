# The Dispatch Center, and what survived it

**Retired:** 2026-09 · **Pre-removal commit:** `051870e2338d2986011f826eb8c88fc03ebfd3fe`

`/dispatch` was a page of its own, outside `/admin`, with no sidebar: upload a
rate confirmation, have a model turn it into a dispatch card, pick a driver's
chat, send it. It carried a second tab — ETA Tracking — that had nothing to do
with any of that beyond sharing the word "dispatch".

This document exists because **most of the removal is about what was kept**.

## What was removed

| | |
|---|---|
| `admin/src/pages/DispatchPage.jsx`, `pages/dispatch/AssistantTab.jsx`, `useDispatchAssistant.js` | the page, the Send Load UI, its hook |
| `POST /api/dispatch/parse-rate-con`, `GET /api/dispatch/groups`, `POST /api/dispatch/send-to-telegram` | and the multer upload wiring they needed |
| `GET /api/dispatch/testing-feature/groups/:groupId/details` | the diagnostics expander's endpoint |
| `services/dispatchTestingDiagnosticsService.js` | what that endpoint called |
| `dispatchParser/{rateConfirmation,aiRequests,templateFormat,fieldExtraction,fieldNormalizers,miles,aiFailures}.js` | the parser: the model reads, the deterministic regex fallback, the template |
| `parseRateConfirmationFile` | the entry point that composed them |
| capability `dispatch_rate_confirmation` | its switch in Settings → AI |
| `GEMINI_DISPATCH_MODELS`, the dispatch system prompt, the Groq chain, the warning lines | the constants only that parser read |
| `api.parseDispatchRateCon`, `api.sendDispatchToTelegram`, `api.getDispatchTestingGroupDetails` | exactly three from the admin's public surface, and the `apiFacade` floor moved by exactly three |

## What was kept, and why each one has a caller

**The ETA schedules.** `EtaTrackingTab` was the ONLY user interface for
per-group ETA delivery and the global intervals. Deleting it with the page would
have turned a screen removal into a data change: rows editable only by hand in
the database. It is now
`admin/src/pages/settings/dispatcherBoard/EtaTrackingCard.jsx`, rendered on the
Dispatcher Board settings tab, and the four
`/api/dispatch/testing-feature/*` endpoints are **unchanged down to the
string** — including the `/api/dispatch` mount point, because renaming them
would have made a UI removal into an API break for no gain.

**`extractRateConRawTextFromFile`.** The pinned-context reader calls it to
answer "what load is this driver on?" when a dispatcher shares a document in a
driver's chat. That is the reading path with a caller outside the deleted page,
so it is the one that survives — along with `dispatchParser/textExtraction.js`
and the two tuning caps still in `constants.js`.

Also kept, each because something else uses it: `dispatchEtaUpdateService`,
`dispatchPinnedContextService` and `pinnedContext/*`, `etaRoutingService`,
`liveLocationResolver`, `database/dispatchEta.js`, the bot's dispatch command
handlers, everything `datatruck*`, and the capability
`dispatch_load_extraction`.

## The diagnostics expander was not a settings control

Each ETA row had a **📋 Details** button that fetched pinned-message previews,
recently ingested loads, coordinates, provider connection status and a live ETA
— reaching Telegram, Samsara and the ETA router on every click. It was a
debugging console wearing a settings page's clothes, and the question it
answered ("is this actually working?") is answered properly by **Operations →
System & AI Health**, from recorded runs rather than a live fan-out.

It went with the page. The settings it sat beside did not.

## `/dispatch` answers 410, and that is load-bearing

The page path is in `RETIRED_PAGE_PATHS`, which is mounted **before** the SPA
catch-all. Without it, `/dispatch` falls through to the shell, the shell finds
no dispatch section, and it renders Driver Groups — a held bookmark quietly
opening an unrelated page, which is worse than an error. This is the same
reasoning that put `/admin/trailers` in that list.

`/api/dispatch` is **not** retired: the ETA endpoints under it are live. The
list holds page paths only.

## Tests that hold this in place

```
node --test tests/api-surface.test.js            # /dispatch → 410; the ETA API 401 then 200;
                                                 # /api/dispatch/groups → 404 WITH a valid token
node --test tests/retiredRoutes.test.js          # every retired prefix answers 410
node --test tests/removedFeaturesStayRemoved.test.js
node --test tests/consumerAiGates.test.js        # one fewer file to check
npm test --prefix admin -- --run apiFacade       # the surface floor, moved by exactly three
```

The `/api/dispatch/groups` check is asserted **with a valid token on purpose**.
The mount is still guarded, so an anonymous request is refused at the gate: a
401 there would prove the auth middleware works, not that the route is gone.
