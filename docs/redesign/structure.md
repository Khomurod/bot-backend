# Admin panel structure (October 2026)

How the panel is organised, why, and where every function from
[`functional-inventory.md`](functional-inventory.md) lives now. This is a change
to navigation and grouping only: no route on the server, request, permission or
business rule moved. Verification is in [`verification.md`](verification.md).

## What was wrong

The panel grew one feature at a time, and the navigation recorded that history
rather than the work:

- **Six sidebar entries opened the same Settings page**, each on a different
  one of its 13 tabs. Once on the page, switching tabs changed neither the
  address nor the highlighted entry, so "Dispatcher Board" could stay lit while
  the AI settings were on screen.
- **Settings was 13 unrelated tabs in one row**: credentials, Telegram
  destinations, bot behaviour, a recruiting workflow, the office race display
  and database maintenance, side by side.
- **Needs Attention had 7 tabs from three domains.** Driver retention (who the
  company may lose) and system health (is every job running) sat beside the
  consistency findings. "System & AI Health" was a second sidebar entry onto
  the same page.
- **One domain in two places.** Company employees' photos and Telegram accounts
  for birthday cards were under Settings → Users & Access → Company Employees,
  while their names and birthdays were under Communications → Birthdays.
- **"Users & Access" granted no access.** It is the directory of Telegram
  accounts the bot has seen.
- **Tabs had no address.** Only the page was in the URL, so no tab could be
  bookmarked or shared.

## The new structure

Five sidebar groups and 14 entries (previously 5 groups and 18 entries, six of
which were the same page). Business work comes first, the system after it, and
configuration last.

| Group | Entry | Address | What it is for |
|---|---|---|---|
| **Drivers** | Driver Groups | `#groups` (opens by default) | Driver identity, status, truck, team |
| | Live Locations | `#live_locations` | Where every truck is now |
| | Home Time | `#home_time` (`/overview`, `/efficiency`, `/settings`) | Home-time tracking; its policy and accounting's violation alerts on their own tab |
| | Mileage Bonuses | `#mileage_bonus` | Bonus progress and notices |
| | Retention | `#retention` | Who the company may lose, and what to do today |
| **Recruiting** | Leads | `#leads` | Every incoming lead |
| | Customer Inquiries | `#facebook_leads` (`/auto`, `/pages`, `/teach`) | What new leads receive, and what Wenze may tell a candidate |
| | Recruiter KPIs | `#recruiter_kpis` | Daily call performance (links to where the targets are set) |
| **Communications** | Messages | `#communications` (`/send`, `/surveys`, `/scheduled`, `/history`, `/edit_by_link`) | What the bot says to driver groups |
| | Birthdays | `#company_birthdays` (`/birthdays`, `/employees`) | Employees, their birthday cards and wishes |
| **Monitoring** | Needs Attention | `#operations` (`/findings`, `/history`, `/checks`, `/identity`, `/learning`) | Where records disagree, what was corrected, what may be corrected automatically, driver identity, Wenze's suggestions |
| | System Health | `#system_health` | Whether every background job is actually running |
| **Administration** | Telegram Users | `#users` | Everyone the bot has seen in Telegram |
| | Settings | `#settings/<section>` | All configuration, grouped |

**Settings** has its own grouped navigation: a list beside the content on a
desktop, a single picker on a phone. Every section has its own address.

| Settings group | Sections (address) |
|---|---|
| Integrations | Location Providers (`location`) · Samsara (`samsara`) · Dispatcher Board (`board`) · RingCentral & Bitrix24 (`ringcentral`) · Facebook ↔ Bitrix (`metacrm`) |
| AI | AI & Autonomy (`ai`) |
| Telegram Bot | Notifications (`notifications`) · Bonus Groups (`groups`) · Group Access (`access`) · Auto Reactions (`reactions`) |
| Recruiting | Safety Approvals (`safety`) |
| Office Screens | Gross Grand Prix (`grossrace`) |
| Maintenance | Retired Leftovers (`leftovers`) |

**Every page-level tab is an address** (`#page/tab`). Switching a tab updates
the address without adding a Back step; a page from the sidebar is a Back step.
A list filter (Driver Groups' views, Telegram Users, Live Locations' units,
Leads' source) is not a tab and stays out of the address. So does the one tab
bar nested inside a tab — Messages → Send Message's Announcement /
Confirmation: it is local to the composer, so `#communications/send` always
opens on Announcement, as Send Message always did.

## Why each decision

- **Drivers first.** Driver Groups is the page the panel has always opened on.
  Retention joins the group because every action on it is something a person
  does for a driver (ring them, answer the request, pay the bonus), not a
  system finding.
- **Monitoring is the system's own state.** Needs Attention keeps the five tabs
  that are one pipeline: findings → corrections history → what may correct
  itself → the identity backfill (a correction-grade action on the same
  permission) → what Wenze learned about its own corrections. System Health is
  its own page because "is everything running?" is not a finding.
- **One Settings entry.** Configuration is set up once and visited rarely. Six
  sidebar entries for it pushed daily work down the list and still did not show
  where most settings were. The Settings page's own grouped list now shows all
  13 sections at once.
- **Settings grouped by kind.** Credentials for outside systems (Integrations);
  the AI configuration; where the bot posts and what it may do in groups
  (Telegram Bot); a recruiting-group workflow (Recruiting); the office race
  screens (Office Screens); one-off database cleanup (Maintenance, last, so it
  is never the first thing a person lands on).
- **Birthdays holds the employees.** The employee list exists for one purpose,
  the birthday card, so the card's data and the birthdays are now two tabs of
  one page. Telegram Users keeps a pointer for anyone who looks there.
- **Bitrix24 is named where it lives.** Its connection is the RingCentral
  section's card on purpose (the Bitrix assignee decides which recruiter's
  number texts a lead, so it sits beside the recruiter rows), and four features
  read it. The section is "RingCentral & Bitrix24" so a person looking for
  Bitrix finds it without knowing that history; "Facebook ↔ Bitrix" is the
  Meta Conversions API and keeps the name the owner gave it.
- **Home Time's configuration has its own tab.** The policy, the notice groups
  and accounting's violation alerts were two screenfuls below the driver table
  people use daily.
- **No two screens share a name.** Needs Attention's "What Wenze learned"
  became **Suggestions** — Settings → AI has "What Wenze learned from you",
  which is a different thing — and "Identity" became **Driver Identity**.
- **Labels say what the screen is.** Location Providers (the ELD keys Live
  Locations uses), Bonus Groups (the two bonus-card destinations, formerly
  "Telegram Groups"), Telegram Users (formerly "Users & Access"), Messages
  (the Communications page), Group Access (formerly "Bot Group Access", now
  under Telegram Bot). Business terms stay as they are: "Customer Inquiries" is
  the recruiting desk's own name.

## Every inventory row, old → new

| Old location | Function | New location |
|---|---|---|
| Login, session check, sign out | Sign in / out | Unchanged |
| Access gate | No `admin.full_access` → "No sections available" | Unchanged (same rule, same check) |
| `/admin#<key>` for 18 keys | Routes | 14 page keys, plus a tab in the address; every old key redirects (below) |
| Legacy hashes | Old bookmarks | Each now opens the exact tab its old page became (below) |
| Back / forward | History | Unchanged for pages; tab changes replace the entry |
| Public `/recruiters`, `/dispatch`, `/dispatchteam` | Displays | Unchanged |
| Sidebar, 5 sections / 18 items | Navigation | 5 groups / 14 entries (above) |
| Database banner, page error boundary | Shell | Unchanged |
| Operations → Needs Attention (`#operations`) | Findings, Run checks now, finding modal, configuration banner | Monitoring → Needs Attention → Needs attention |
| Operations → History tab | Corrections journal, revert | Monitoring → Needs Attention → History |
| Operations → Automation tab | Per-check modes, caps, preview | Monitoring → Needs Attention → Automation |
| Operations → Identity tab | Coverage, preview / apply backfill | Monitoring → Needs Attention → Driver Identity |
| Operations → What Wenze learned tab | Suggestions, engineering requests | Monitoring → Needs Attention → Suggestions |
| Operations → Retention tab | At-risk drivers, acknowledge, "Record what drivers write" | **Drivers → Retention** (own page) |
| System & AI Health (`#system_health`) = Operations → What is running | Systems list | **Monitoring → System Health** (own page, with the alert-delivery banner) |
| Operations → Live Locations | Map, filters, search, refresh, diagnostics | Drivers → Live Locations |
| Operations → Driver Home Time | Overview (driver list, import, unlinked activity, driver modal), efficiency, settings, violation alerts | Drivers → Home Time: Overview · Efficiency · **Settings & Alerts** (settings and violation alerts) |
| Groups → Groups | Five views, row editors, driver modal, AI enrich | Drivers → Driver Groups |
| Groups → Mileage Bonuses | Run check, refresh, resend / disregard | Drivers → Mileage Bonuses |
| Communications → Communications | Send Message (Announcement / Confirmation), Surveys, Scheduled, History, Edit by Link | Communications → Messages (same five tabs) |
| Communications → Birthdays | Birthdays list, add / edit / delete, settings, send, request, custom message | Communications → Birthdays → Birthdays |
| Settings → Users & Access → Company Employees | American name, Telegram account, photo, card, suggest / confirm | **Communications → Birthdays → Employees** |
| Settings → Users & Access (other filters) | Telegram users seen, filters, search, refresh | Administration → Telegram Users |
| Recruiting → Leads | Leads table, source filter, Indeed script | Recruiting → Leads |
| Recruiting → Customer Inquiries | Auto-reply, pages, Teach Wenze + working hours | Recruiting → Customer Inquiries |
| Recruiting → Recruiter KPIs | KPIs, date, sync | Recruiting → Recruiter KPIs |
| Settings → Live Location | ELD provider keys, tests | Settings → Integrations → Location Providers |
| Settings → RingCentral | Credentials, targets, recruiters, Bitrix24 connection | Settings → Integrations → RingCentral & Bitrix24 |
| Settings → Facebook ↔ Bitrix | Meta CAPI for CRM | Settings → Integrations → Facebook ↔ Bitrix |
| Settings → Samsara | Connection, safety events, video recovery, music | Settings → Integrations → Samsara |
| Settings → Dispatcher Board (also its own sidebar entry) | Feed, Board ↔ Bitrix check | Settings → Integrations → Dispatcher Board |
| Settings → AI (also "AI & Autonomy" in the sidebar) | Providers, order, health, responsibilities, lessons, terms watcher | Settings → AI → AI & Autonomy |
| Settings → Notifications (also "Notification Routing") | Routing, control channel | Settings → Telegram Bot → Notifications |
| Settings → Telegram Groups | Mileage / road bonus group ids | Settings → Telegram Bot → Bonus Groups |
| Settings → Bot Group Access (also its own sidebar entry) | Super admin, groups table, recheck, request admin, export | Settings → Telegram Bot → Group Access |
| Settings → Auto Reactions (also its own sidebar entry) | Reaction rules | Settings → Telegram Bot → Auto Reactions |
| Settings → Safety Approvals | Chat, topic, Safety people, hiring stages | Settings → Recruiting → Safety Approvals |
| Settings → Gross Grand Prix | Celebration video, Windows sound | Settings → Office Screens → Gross Grand Prix |
| Settings → Retired Leftovers | Purge roles, drop tables | Settings → Maintenance → Retired Leftovers |

## Old addresses

| Old address | Opens |
|---|---|
| `#settings`, `#settings_integrations` | `#settings/location` |
| `#settings_board` | `#settings/board` |
| `#settings_ai` | `#settings/ai` |
| `#settings_notifications` | `#settings/notifications` |
| `#settings_reactions`, `#auto_reactions` | `#settings/reactions` |
| `#settings_access`, `#group_access` | `#settings/access` |
| `#broadcast` | `#communications/send` |
| `#questions` | `#communications/surveys` |
| `#scheduled` | `#communications/scheduled` |
| `#bot_messages` | `#communications/history` (the bot-message log) |
| `#manager` | `#communications/edit_by_link` (the old page predates the repository's kept history; its name and the tab that edits any sent message by its link are the closest match) |
| `#operations`, `#system_health`, and every other old page key | The same page as before |
| Anything unrecognised | Driver Groups, as always |

## Considered and deliberately not done

- **Bitrix stage proposals as their own section.** The card shares Safety
  Approvals' loaded settings and its save (`SafetyApprovalsTab` passes them
  in), so a separate section would mean a second loader for the same row — a
  logic change, not a move. It stays as card 5 of Safety Approvals, where
  `docs/architecture/hiring-stage-proposals.md` documents it.
- **Group Access as a status board outside Settings.** It mixes configuration
  (the super admin) with status; splitting it is a feature change.
- **Renaming Needs Attention or Customer Inquiries.** Both are the names the
  company uses (the "Needs-attention group" in Telegram, the recruiting desk).

## How it was verified

- A crawl opened every page and every page-level tab **by its new address**,
  desktop (1440×900) and phone (390×844), clicked every list filter and nested
  tab and opened the three modals; 0 console errors.
- Each of the 69 screens of the previous crawl was matched to the screen it
  moved to, and every content control (buttons, fields, links, table columns)
  compared, navigation excluded. Nothing was lost. The differences are the
  intended ones:
  - Telegram Users lost the "Company Employees" filter and gained a link to
    Birthdays → Employees.
  - Settings → AI gained a link to Needs Attention → Automation.
  - On a phone, Settings shows the section picker.
  - One finding group that the earlier crawl happened to leave expanded was
    collapsed this time.
- Phone flows were checked in the browser:
  - an old `#group_access` lands on Group Access and its address is rewritten;
  - choosing a menu entry closes the drawer;
  - the section picker updates the address;
  - Settings is visible in the drawer without scrolling.
- An independent UX review and an independent code review were run on the
  result. What they found and what was done:
  - The query string was dropped on a tab change. Fixed.
  - A crashing Settings section locked all of Settings. Fixed with a boundary
    per section.
  - An unknown tab stayed in the address. Fixed: the address is now corrected.
  - Server texts named old screens. Fixed.
  - Three helpers were only called by tests. Removed.
  - The Bitrix24 name, Home Time's settings, the "What Wenze learned" name
    clash and the KPI targets link were changed as described above.
