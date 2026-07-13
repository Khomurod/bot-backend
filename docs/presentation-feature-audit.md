# Presentation Feature Audit (internal)

Purpose: confirm which platform features actually exist and work **today**, so the
owner-facing `/presentation` page advertises only real capabilities. Compiled from a
direct code inspection of the `bot-backend` repo (admin app, FleetView app, Telegram
bot, backend services) and the companion `samsara-integration` service, plus recent
merged/open PRs. Date: 2026-07-13.

> This file is internal engineering reference only. It is **not** shipped to the public page.

## Legend
- **WORKING** — present and wired in current code.
- **BETA** — present but explicitly labeled Beta in the UI (present as Beta).
- **RETIRED** — removed from the codebase; must NOT be advertised.
- **INTERNAL** — real but not owner-facing value; keep off the public page.

---

## Admin Portal (admin/src) — hand-rolled nav in App.jsx
Operations: Dispatch Center, Live Locations, Route Control, Trailer Tracking, Leads
(Facebook + Indeed), Customer Inquiries (Meta lead-ads), Recruiter KPIs — all WORKING.
Communications: Send Message / Broadcasts, Surveys (Questions) — WORKING.
Team: Driver Groups, Birthdays, Mileage Bonuses, Driver Raises, Driver Home Time,
Fuel Monitor, Users, Bot Group Access — WORKING.
Admin: Edit Message, Bot Messages, Scheduled Messages, Settings/integrations — WORKING.
Public routes: `/dispatch`, `/raise`, `/recruiters` (leaderboard) — WORKING.

- **AI Insights page** — present in code but NOT routed/imported (orphaned). Do NOT advertise.

## FleetView (fleet/src) — dispatch-focused SPA at /update
- Dashboard, Tasks, Loads, Update Board, Dispatch Board, **Dispatch Map**, Emails,
  Rate Savings, Statistics — WORKING.
- Site Users, Brokers, Drivers (read-only; create is "coming soon"), Equipment,
  Fuel & Tolls, My Companies — WORKING.
- **Trailer Tracking — BETA** (UI literally renders "Trailer Tracking (Beta)").
- **Dispatch Map** is FleetView's operational map: truck markers + trailer markers,
  asset views (All / Trucks only / Trailers only), trailer state filters
  (with-driver / dropped, loaded / empty / unknown, needs-review, location quality),
  quick-filter chips, live count chips, polled ~30s. WORKING (recent, PR #103).

### Attribution cautions
- **Live Locations** and **Route Control** are **Admin** features, NOT FleetView.
- FleetView's operational map is **Dispatch Map** (do not call it "Live Locations").

## Telegram bot (bot/) — driver-facing
- Anonymous feedback, Home-time request flow, Mileage-bonus submissions,
  Dispatch/load lookup (`/status`), Location check-ins — WORKING.
- Multilingual auto-translation: **English / Russian / Uzbek** (translationService.js).
- Broadcasts & scheduled message delivery — WORKING.
- Datatruck peer "banter/roast" bot — INTERNAL (fun, not owner value; keep off page).

## Trailer Tracking backend (production-grade, UI still Beta)
- Mandatory AI semantic verification before any status change (trailerSemanticVerifier.js).
- Vision service for trailer photos; deterministic + AI message parsing.
- Unified trailer-state source of truth (possession, cargo, display status, needs-review)
  shared by Dispatch Map overlay + Trailer Tracking page.
- Review/approval workflow with audit columns + event history/timeline.
- Present on the page as **Beta**.

## Safety & monitoring
- **Samsara safety events** (speeding events, dashcam video) are delivered to the
  Samsara notifications group and forwarded to the relevant **driver group** — handled
  by the companion `samsara-integration` service (speedingPoller, safetyEventMedia,
  driverGroupDelivery). WORKING.
- **Safety-event music overlay** (admin Settings → Safety Events): embeds background
  music into the driver-group copy of a speeding dashcam video; the notifications group
  always gets the original, unchanged. WORKING but niche — mention lightly, not a headline.
- **Fuel Monitor**: flags fuel-card / gas-stop activity vs the truck's GPS location.
  WORKING. (Open PR #34 adds a "Refresh last 12h" button — not yet merged; do not
  advertise the refresh button specifically.)

## Recruiting & KPIs
- Lead intake from **Meta/Facebook** and **Indeed**; auto-reply SMS + Telegram mirror;
  **Bitrix24** CRM hand-off. WORKING.
- **Recruiter KPIs** (RingCentral call log): main KPI **2h 30m real call duration/day**,
  secondary **150 outbound calls/day**, ~35 real conversations; date picker for history;
  gamified public leaderboard at `/recruiters` (PR #98). WORKING.

## Integrations confirmed wired (service adapters present)
Telegram · Datatruck (TMS) · Samsara (ELD/GPS + safety) · RingCentral (calls/SMS) ·
Bitrix24 (CRM) · Meta/Facebook (leads) · Indeed (leads) · Google Maps ·
Factor / Leader / Drive HoS (ELD fallbacks) · OpenAI / Groq / Gemini (AI: translation,
classification, vision).

## RETIRED — must NOT be advertised
- **BOL/POD monitoring / document intake** — fully removed in PR #97 and pinned by a
  regression test (`tests/bolPodRetired.test.js`). The old presentation's
  "BOL / POD document delivery" card and inventory row must be removed.
  (A separate outbound `datatruckDocumentService` still exists as a background service
  with no admin page; it is not owner-facing and is intentionally left off the page to
  avoid reviving retired BOL/POD wording.)

## Removed from the redesigned page (too technical / stale)
- Architecture diagram (Node.js/Express/React/PostgreSQL, service counts, `/admin`,
  `/update`, `/api/v1`, workers/processes, webhook/JWT/adapter language).
- Full feature-inventory table and long role-by-role feature lists.
- "15+ background jobs / 80+ service modules" style counts.
- BOL/POD card (retired).

## Unverified specifics to avoid stating
- Exact raise amount ("75¢/mile") — not confirmed as a fixed value in current code; use
  neutral wording ("driver raise requests with verification and approval").
- Any cost-savings or percentage-improvement claims.
</content>
</invoke>
