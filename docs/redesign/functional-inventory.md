# Admin panel — functional inventory (before the October 2026 redesign)

The checklist the redesign was verified against. Every row was a working part of
the panel at main `2b5dd31` (restore point: branch `backup/pre-redesign-2026-10-30`).
After the redesign each row was re-checked — see [`verification.md`](verification.md). Where each row lives since the October 2026 structure: [`structure.md`](structure.md).

Machine-made companions, on the never-merged branch `redesign/visual-baseline`:
`before/inventory-{desktop,mobile}.json` (every visible button, link, field and
table header per screen and tab), `before/static-inventory-before.json` (per
source file: API calls, handlers, fields, uploads, downloads, confirmations,
clipboard), and full-page screenshots of 151 screens at 1440×900 and 390×844.

**Scope.** The admin SPA (`admin/`): `/admin#<page>` and the public `/recruiters`
leaderboard. Out of scope, deliberately, because they are display surfaces with
their own purpose-built look rather than admin screens: the Gross Grand Prix
office displays `/dispatch` and `/dispatchteam`, the presenter remote `/remote`
and `/presentation` (server-rendered pages).

## Shell, routes and access

| Item | What it does | Where |
|---|---|---|
| Login | username + password → `POST /api/auth/login`; error shown; token in `localStorage` | `pages/LoginPage.jsx` |
| Session check | `GET /api/auth/verify` on load; a bad token is dropped | `App.jsx` |
| Access gate | no `admin.full_access` → no sidebar items and a "No sections available" card | `App.jsx`, `AdminSidebar.jsx` |
| Routes | `/admin#<key>` for 18 keys; `#communications/<tab>` reads the page half | `navigation/pageKeys.js` |
| Legacy links | `#broadcast #questions #scheduled #bot_messages #manager` → communications; `#settings` → settings_integrations; `#auto_reactions`, `#group_access` → their Settings tabs; unknown → Groups | `pageKeys.js LEGACY_PAGE_KEYS` |
| Back/forward | `popstate` + `hashchange` move page and highlight | `App.jsx` |
| Public pages | `/recruiters` (leaderboard), `/dispatch`, `/dispatchteam` (race) — no chrome, no auth | `App.jsx` |
| Sign out | clears session, drops the hash | `App.jsx` |
| Sidebar | 5 sections, 18 items (order in `NAV_SECTIONS`); mobile drawer | `components/AdminSidebar.jsx` |
| Database banner | shown at 80%+ of the monthly transfer allowance | `components/DatabaseUsageBanner.jsx` |
| Page error boundary | per page, resets on navigation; "Could not load this page" + retry | `components/PageErrorBoundary.jsx`, `PageFailure.jsx` |

## Operations

| Screen | Tabs | Actions and fields | Modals / conditional |
|---|---|---|---|
| Needs Attention `#operations`, System & AI Health `#system_health` (same page, opens on "What is running") | Needs attention · History · Automation · Identity · Retention · What Wenze learned · What is running | **Needs attention:** severity summary, findings grouped by check (expand ▸/▾), "Include dismissed and snoozed", Run checks now. **History:** corrections journal, revert. **Automation:** per-check mode, auto-apply, caps (Save cap), Preview. **Identity:** coverage, Preview / Apply backfill. **Retention:** acknowledge, "Record what drivers write" switch. **Learned:** accept / decide / revert suggestions; engineering requests decide. **Running:** systems list. | Finding detail modal (apply correction, dismiss with reason, forget remembered answer); configuration banner when alerts cannot be delivered |
| Live Locations `#live_locations` | filters: All · Active load · No active load · Stale GPS · Samsara · Factor ELD · Leader ELD | search by unit/driver, Auto refresh on/off, Refresh, Diagnostics, Fit visible, unit list (click → map focus + route), map zoom, open in maps (new tab) | diagnostics panel; empty / no-GPS rows |
| Driver Home Time `#home_time` | Overview · Driver Home Time Efficiency | driver list (sort, filter, search), status change, status-since edit, request create / date edit, trip edit / delete, settings card (save), violation alerts card + webhook link (copy, rotate with confirm), screenshot import (file upload → preview → apply), unlinked activity | driver detail modal (requests, trips, history, actions); efficiency table with expandable rows |

## Groups and people

| Screen | Tabs | Actions and fields | Modals / conditional |
|---|---|---|---|
| Groups `#groups` | All · Active Drivers · Inactive Drivers · Company Chats · Needs Review (with counts) | "AI: enrich status + identity" (confirm), per-row type select, status select, unit input, sort by status, driver name link | driver detail modal: names, team second driver, type, status, unit, language, dates, Telegram username/id, group members, person identity panel, save |
| Mileage Bonuses `#mileage_bonus` | — | overview, Run check, Refresh progress, per-driver status, resend / disregard notification (each with confirm) | empty state before the first run |
| Users & Access `#users` | All · Admins · Company Employees · Drivers · Unknown · Recently seen | search; Company Employees: edit, photo upload / delete, card link, Telegram suggest / confirm | per-row details |

## Communications

| Screen | Tabs | Actions and fields | Modals / conditional |
|---|---|---|---|
| Communications `#communications` | Send Message (Announcement · Confirmation) · Surveys · Scheduled · History · Edit by Link | **Send:** targeting (all / languages / active filter / individual groups), EN/RU/UZ text with formatting toolbar, placeholders, translate, media upload, Telegram preview, test send, send now, schedule (one-time / weekly). **Confirmation:** same plus button text, click tracking. **Surveys:** questions and responses. **Scheduled:** list, send now, cancel. **History:** broadcasts, deliveries, clicks; bot messages edit / delete. **Edit by Link:** paste a Telegram link → edit text / delete | confirmations before send / delete; delivery detail rows |
| Birthdays `#company_birthdays` | — | employee birthdays list, add / edit / delete, settings, send wishes now, request birthdays, custom message to the employee group, congratulate selected | confirm before sends |

## Recruiting

| Screen | Tabs | Actions and fields | Modals / conditional |
|---|---|---|---|
| Leads `#leads` | — | leads table (source, name, contact, status…), copy phone / email (clipboard), open in Bitrix (new tab) | empty state |
| Customer Inquiries `#facebook_leads` | Auto-Reply Setup · Connected Pages · Teach Wenze | auto messages per page (edit, preview, save), recruiter messages; pages + webhook log, retry an event (confirm); teach Wenze (statements, list) and working hours | — |
| Recruiter KPIs `#recruiter_kpis` | — | period select, stats table, Sync calls | — |
| `/recruiters` public | — | leaderboard, auto refresh | full-bleed, no auth |

## Settings (`#settings_integrations`, `#settings_board`, `#settings_ai`, `#settings_notifications`, `#settings_reactions`, `#settings_access` — one page, 13 tabs)

| Tab | Actions and fields |
|---|---|
| Live Location | Samsara / Factor / Leader ELD keys, enable switches, Test per provider, Save |
| RingCentral | credentials, Test, Save; recruiters list: add, edit, delete (confirm), connect link, test connection, test SMS, diagnose, clear login (confirm), Bitrix user check; Bitrix connection form, diagnose, automap recruiters |
| Facebook ↔ Bitrix | status, switch, dataset id, token (write-only), test event code, Test (checks a–d), Save (locked until a passing Test) |
| Telegram Groups | per-category message group ids, save |
| Samsara | connection (key, test, save, confirm on clear), safety events music (upload / activate / deactivate / delete), video recovery, export (download) |
| Dispatcher Board | enabled, URL, token (write-only), interval, Save, Test connection, Feed card (refresh), Board ↔ Bitrix check card (switch, counts, Check now) |
| Safety Approvals | chat, topic, switches, validate chat, test post, save; hiring-stage proposals card |
| AI | master switch, providers (add, test, refresh models, cooldown clear, edit), provider order, model chains, responsibilities (capability modes, check modes), lessons (remove, skip question), policy watcher (sources add / delete, run, test notification, acknowledge) |
| Notifications | default group, per-category overrides, test a chat, preview, save; control channel (operators add / remove, settings, remembered answers forget) |
| Auto Reactions | list / manual mode, emoji picker, rules enable / delete (confirm), save |
| Bot Group Access | settings, groups table, recheck, request admin, export (download) |
| Gross Grand Prix | celebration video upload / delete (confirm) / pause, Windows sound command (copy) |
| Retired Leftovers | list, purge config, drop tables (typed confirmation) |

## States checked on every screen

Loading (spinner / "Loading…"), empty (no rows), error (alert or page failure with
retry), success feedback (banner / toast text), disabled buttons while busy,
mobile layout (drawer navigation, wrapped tab bars, horizontally scrolling tables).
