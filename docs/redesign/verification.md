# Admin panel redesign — verification (October 2026)

What the redesign changed, how every row of
[`functional-inventory.md`](functional-inventory.md) was re-checked, and what
is still only as good as the local check that covered it.

**Restore point.** Branch `backup/pre-redesign-2026-10-30` = main `2b5dd31`, the
last commit before the redesign. Reverting the redesign's merge commit restores
it exactly. Nothing outside `admin/`, `docs/redesign/` and the brief changed, so
the revert touches no API, schema, job or bot behaviour.

## What changed — and what deliberately did not

| Changed | Not changed |
|---|---|
| One design system: every colour is a token in `admin/src/styles/01-design-system.css`, in a light theme (default) and a dark one | Any route, request, response, permission check or API client function |
| Light / dark switch in the sidebar footer; no choice = follow the operating system; remembered per browser (`localStorage` key `wz-theme`), applied before first paint by `admin/index.html` | Business logic, validation, confirmations, what a button sends |
| One shared tab bar (`components/ui/TabBar.jsx`, WAI-ARIA tablist; ←/→/Home/End move focus, Enter / Space opens, so arrowing never opens a tab on the way) on every tabbed screen: Settings, Communications, Send Message, Operations, Groups, Customer Inquiries, Users, Live Locations, Home Time, Leads | Tab names, order, counts, and which tab a deep link opens |
| New shell: sidebar with line icons (`components/ui/Icon.jsx`), user chip, theme switch; on phones and narrow tablets a sticky top bar with the menu button and the page title, a drawer sidebar and a backdrop that closes it | Sidebar sections, entries, labels and order; every `/admin#<key>` and legacy hash |
| Decorative emoji removed from page and card headings (content, buttons and messages keep theirs) | Text of buttons, labels, messages and help |
| ~430 hard-coded colours in page code replaced with tokens, so text stays readable in both themes; a separate orange `--caution` keeps "Failing" apart from "Blipped" (Systems) and the 90% database banner apart from the 80% one | The public `/recruiters` leaderboard and the Gross Grand Prix displays (the admin typography is scoped to `.app-layout` / `.login-container` so they keep their own headings and links); Telegram's blue in the message preview; the Facebook / Indeed brand badges; the map pins |
| Lead status badges use the shared status pills; dark code blocks became theme-aware panels | Every card is still its own stacking context (`isolation: isolate`, which the old frosted-glass blur used to provide), so the map stays under the phone top bar and drawer |

**Why not Tailwind / shadcn components.** The panel is ~190 page files of inline
styles over a shared class vocabulary (`.card`, `.btn`, `.form-input`,
`.badge`…). Rewriting them onto a component library would have touched every
handler in the app, with no gain a person could see. Instead shadcn/ui's design
language (neutral zinc surfaces, one indigo accent, 1px borders, small radii,
quiet shadows) was written into those shared classes and tokens, so every page
picked it up without its logic being edited. No dependency was added.

## Fixes found on the way

- **Home Time → Driver Home Time Efficiency rendered its whole report twice** —
  two identical `<HomeTimeEfficiencyTab>` elements, each loading its own data.
  Now once (`HomeTimePage.jsx`).
- `alert-danger`, `muted` and `p.error` / `div.error` were used by pages and
  styled nowhere; they now have styles (`12-ui.css`).
- Selects with an inline `padding` drew their text under the arrow.
- On a phone a table could shrink a column to one letter per line (Groups);
  cells now break only between words and the table scrolls inside its card.

## Behaviour changes — the complete list

Nothing a request sends, a permission allows or a page decides changed. What a
person can notice beyond the look:

- The Home Time efficiency report is drawn — and its data loaded — once.
- Tab bars answer the keyboard: arrows move focus, Enter / Space opens.
- The light / dark switch in the sidebar.
- On a phone the top bar stays at the top while scrolling, and tapping outside
  the open menu closes it.
- An account without access sees "Wenze" in the phone top bar rather than the
  name of a page it cannot open.

## Independent review

The full diff was reviewed separately from the implementation (code-review,
high). It found ten issues; all were fixed before the PR:
the admin heading and link colours reaching the public displays (now scoped);
cards no longer being stacking contexts, letting the map cover the phone top
bar (restored with `isolation`); the dark date-picker icon inverted twice
(the filter removed — `color-scheme` already draws it); arrow keys opening
every tab on the way (manual activation); the theme switch's label not
following an OS change (it listens now); the Telegram preview's white-on-white
header and buttons in the light theme (tokens); `.badge` text no longer
wrapping (wraps again); the 80% and 90% database banners sharing one colour
(`--caution`); two meaningless `var()` fallbacks; and two overstatements in
the brief.

## How it was verified

A local harness (scratchpad only, never committed, never pointed at
production): a throwaway PostgreSQL 16 database with the real `schema.sql` and
fictional seed data, the real Express server with fake tokens and no bot or
background jobs, and the production admin build. A Playwright crawler logged in,
opened all 18 pages, clicked every tab and nested tab, opened the driver, finding
and home-time modals, and recorded every visible button, link, field, table
header and heading — before (on `2b5dd31`) and after, at 1440×900 and 390×844.
The before set and screenshots are on the never-merged branch
`redesign/visual-baseline` (`before/`), the after set beside it (`after/`).

| Check | Result |
|---|---|
| Screens captured | 150 desktop + 150 mobile after vs 151 + 151 before (the one extra was the public leaderboard screenshot, captured separately) |
| Desktop parity, every control on every screen | identical, except the Home Time Efficiency controls now appear once instead of twice (the fix above) |
| Mobile parity | identical, except the ☰ menu button is now labelled "Open menu" |
| Table headers | none lost on any screen |
| Headings | same text once decorative emoji are ignored |
| Console errors while crawling | 0 |
| Dark theme, desktop and phone, 13 main screens | readable; captured as `extra/dark-*` |
| Phone drawer | opens from the top bar, closes from the backdrop, closes and navigates when an entry is tapped |
| Limited account (no `admin.full_access`) | no sections, "No sections available", Sign Out works; the top bar says "Wenze", not a page it cannot open |
| Deep links | covered by `navigation/pageKeys.test.jsx` and `App.test.jsx` (unchanged routing code) |
| Public displays `/recruiters`, `/dispatch`, `/dispatchteam`, old build vs new, light and dark OS | pixel-identical apart from the live clock, and on `/recruiters` the date-picker icon, which is now drawn by the page's own colour scheme instead of the old panel-wide `invert(0.7)` filter |

### Inventory, row by row

| Inventory row | After the redesign |
|---|---|
| Login, session check, sign out | Same requests and storage; the form gained proper `<label for>` and autocomplete |
| Access gate | Same rule; covered by `AdminSidebar.test.jsx` |
| Routes, legacy links, back / forward | Routing code untouched; every key still has one sidebar entry (test) |
| Sidebar | Same 5 sections, 18 entries; mobile drawer → off-canvas drawer + backdrop |
| Database banner, page error boundary | Untouched components, retinted by tokens |
| Needs Attention / System & AI Health | 7 tabs (shared tab bar), every action present, finding modal opens |
| Live Locations | 7 filters, search, Auto / Refresh / Diagnostics / Fit visible, map and list |
| Driver Home Time | Both tabs, every card, driver modal; efficiency rendered once |
| Groups | 5 views with counts, row editors, driver modal, AI enrich |
| Mileage Bonuses | Refresh data, Run check & notify, tiers, progress, notifications |
| Users & Access | 6 filters, search, refresh, Company Employees tab |
| Communications | 5 tabs; Send Message's Announcement / Confirmation; every editor, preview, schedule and history control |
| Birthdays | List, editors and sends unchanged |
| Leads | Source filter (All / Facebook / Indeed) now the shared tab bar; table, Indeed script, copy |
| Customer Inquiries | 3 tabs, rules, preview, Save / Reset |
| Recruiter KPIs | Date, Sync now, targets, cards |
| Settings, 13 tabs | Every tab opened from all six Settings entries; every field and button present |
| States | Loading, empty and error text unchanged; disabled buttons still disabled |

## Performance

Production build, same machine, before (`2b5dd31`) → after. First load (the
`index` CSS + JS every visit downloads): **61.1 kB → 62.4 kB gzip** (+1.2 kB: the
icon paths, the tab bar and the theme switch). Stylesheet **6.9 → 6.1 kB gzip**
after removing ~870 lines of rules nothing used. All JS and CSS together: 507.8
→ 508.7 kB gzip. Pages are still lazy-loaded exactly as before. No new
dependency.

## Cleanup — removed only with proof of no caller

Style rules for classes that no file in `admin/src` (nor `admin/index.html`)
names, directly or as a template prefix: the old wizard, quick-query cards, lead
cards, page-header bar and CTA, the earlier Telegram preview and media-uploader
styles (the live preview draws itself with inline styles), the old broadcast and
AI tab bars, the glass modal, the AI Insights v2 cards, `btn-success`,
`btn-block`, and translation / option grids. No component, page, script, test,
route, migration or document was deleted.

## Limits of this verification

- The harness ran with fictional data and with no Telegram, Samsara, Bitrix,
  RingCentral or Meta connection, so screens were checked in their
  "not configured" and seeded states. A send, a test connection or an upload
  was not exercised end to end: their code is unchanged and their component
  tests pass.
- The `/dispatch`, `/dispatchteam`, `/remote` and `/presentation` displays were
  out of scope and are untouched.
- Screens were reviewed in Chromium only.
