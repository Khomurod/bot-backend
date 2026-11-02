# Admin panel density (November 2026)

The October 2026 restructure ([`structure.md`](structure.md)) fixed WHERE each
screen lives. This plan fixes what is ON each screen. The owner's request, in
their words: every window should be pleasant to look at and very easy to
navigate; merge where it makes sense, split where needed. "Right now many
sections have far too much information in one window."

It comes from an audit of all 40 screens on main `bd49714`, at desktop
(1440×900) and phone (390×844) sizes, rendered locally with fictional data.
Every proposal below was presented to the owner, who approved implementing
them as planned.

## What the audit found

| State | Screens |
|---|---|
| **Overloaded** | Settings → AI & Autonomy: 6.6 desktop screens, 13 on a phone, six unrelated jobs · System Health: 42 cards, problems not first · Settings → RingCentral & Bitrix24: 6 cards, three subjects · Customer Inquiries → Auto-Reply: two identical previews, Save 1,800 px from the first field · Home Time → Settings & Alerts: 414 words of hints |
| **Heavy** | Group Access · Samsara (two forms, two Save buttons) · Notifications · Driver Groups · Home Time → Overview and Efficiency · Messages → Send Message · Birthdays · Needs Attention (a long header on every tab) · Customer Inquiries → Teach · Live Locations (on a phone) · Mileage Bonuses (with real data) |
| **Fine, left alone** | Leads · Retention · Telegram Users · Recruiter KPIs · Customer Inquiries → Pages · Surveys · Scheduled · History · Facebook ↔ Bitrix · Dispatcher Board · Location Providers · Gross Grand Prix · Admin Accounts |

The cause is almost always the same. Daily work, one-time configuration and
long explanations share one scroll.

## Rules every change follows

1. **The daily job comes first.** One-time configuration goes below it, or
   collapsed.
2. **Problems come first.** Healthy, clean or already-done items collapse into
   one line with a count.
3. **One line of explanation, with the rest behind "How this works".** No file
   paths, changelog wording ("now carries…") or internal keys in visible text.
4. **One Save per screen.** Two independent forms become two screens.
5. **On a phone, a wide table becomes cards.** Nothing important is behind a
   sideways scroll.

## Guardrails

- **Layout only, unless a line below says otherwise.**
  - No server route, request, permission, setting or business rule changes.
  - A screen that moves still calls the same API with the same payload.
  - Where a form is split, the server already accepts a partial update:
    `updateRcSettings` skips absent fields, so the moved KPI targets save on
    their own.
- **Nothing is lost.** For every PR, two crawls of the main-area controls are
  compared: buttons, fields, links and table columns, before vs after, on
  desktop and phone.
  - Every control must still exist somewhere.
  - A control may only become collapsed, never deleted, unless this plan says
    so.
- **Every old address still opens the right place.**
  - Section keys are never renamed.
  - A split section keeps its key for the part people used it for.
  - A merged section's old key opens the merged one.
  - `#settings/notifications` and `#settings/groups` must both land on "Where
    the Bot Posts".
- **Each PR runs:** `npm test --prefix admin`, `npm run build --prefix admin`,
  `lint:undef`, `lint:imports` and `lint:filesize`. It updates
  `docs/redesign/structure.md` and the App Brief wherever a name or a place
  changed.

## Decisions taken where the audit offered a choice

- **A1-b, yes:**
  - "Answering Wenze in Telegram" (now under Notifications) and "What Wenze
    learned from you" (now under AI) become one section, **Wenze's
    Questions**. Both are "Wenze asks in the notifications group, you
    reply".
  - What remains under Notifications is only "where messages go".
- **A2 targets go to Recruiter KPIs:**
  - The KPI targets and thresholds become a **Targets** tab of Recruiter KPIs
    (`#recruiter_kpis/targets`), next to the numbers they score.
  - The page's link to Settings now points there.
- **Birthdays' two employee tables stay two tables for now.** Merging them is
  a behaviour change (the Telegram-suggestion confirm flow) and is not in this
  plan.
- **Teach:** "Conversations Wenze is carrying" moves to the top of the tab,
  not to Leads. A second place would mean a second read.

## The PRs, in order

Status: ☐ planned · ◐ in review · ☑ merged.

### 0 — Errors found by the audit (not layout)

| # | Change | Must not be lost |
|---|---|---|
| ◐ 0 | **Birthdays:** "Send Telegram Request" posts to the employee group with no confirmation. The confirm dialog exists, but nothing opens it. Fix: route the button through it and make it a secondary button. **Customer Inquiries:** the four tiles above every tab read 0 until another tab had loaded their data (the Pages list is fetched only on its tab because it asks Meta; Events only in developer mode). Fix: the tiles go, and the page counts move onto the Pages tab beside the list they count. **Needs Attention:** nine checks showed their raw key: `home_time.board_disagrees_with_state`, `home_time.exhausted_internal_alerts`, `identity.bot_not_member`, `identity.unit_title_mismatch`, `ops.no_notification_destination`, `ai.policy_source_lost`, and the contradiction pass's three `context.*` kinds, which are derived from its SEVERITY table. Fix: give them plain names, plus a test that every key the backend can file has one. The empty History said "every check ships disabled" while Automation showed checks switched on. **Hints:** "Needs Attention → Identity" becomes a link to Driver Identity. The "Settings → RingCentral" mentions are renamed in A2, where those sections get their new names. **Sidebar:** the last entry was cut off under the user footer on a 900 px-high screen. Fix: the theme switch becomes an icon on the user row. | The request still sends after the confirm. The page counts and the developer event log stay. Dark/Light mode stays one click away. |

### A — Settings

| # | Change | Must not be lost |
|---|---|---|
| ☐ A1 | **AI & Autonomy splits into four sections:** **AI Providers** (`ai`: the switches, provider order, provider cards, 24-hour health) · **AI Tasks** (`ai_tasks`: each responsibility a compact row of name, badges and switch, with the explanation on expand) · **Wenze's Questions** (`ai_questions`: "Ask me when unsure", the lessons, and the Telegram question settings moved from Notifications) · **Provider Terms** (`ai_terms`: the terms watcher). File paths leave the capability texts. | Every switch, cap and "With AI off" text. The Telegram-question settings save exactly as before. |
| ☐ A2 | **RingCentral & Bitrix24 becomes:** **Recruiters & Numbers** (`ringcentral`: the list first; Invite and Add manually open from buttons) · **RingCentral Connection** (`rc_connection`: credentials, monitoring switch, test) · **Bitrix24** (`bitrix`: the connection and recruiter matching, without the readout that repeats the form). Targets and thresholds move to Recruiter KPIs → **Targets**. Every hint that still says "Settings → RingCentral", in the admin and in the server's own error messages, names the new section. | Every field. Credentials and targets save as before; each form sends only its own fields. |
| ☐ A3 | **Samsara splits in two:** **Samsara** (`samsara`: connection, safety events, video recovery) and **Samsara Video & Music** (`samsara_video`). Location Providers shows the shared Samsara key's status and links to Samsara instead of a second key field. | The key is still settable, tested and clearable, in one place. |
| ☐ A4 | **Notifications and Bonus Groups merge into "Where the Bot Posts"** (`notifications`): the default group, the per-category overrides collapsed as "Send some elsewhere (8)", and the two bonus groups. | Every destination, every "Send an example", the delivery line. `#settings/groups` lands here. |
| ☐ A5 | **Group Access:** a list of problems first; the healthy groups as "N reading normally — show". The super-admin card collapses to one line once set. **Auto Reactions:** the active rules first; "Add a rule" opens the form. **Safety Approvals:** once set up, steps 1–4 become one summary line with Edit, and the latest Safety replies come first. **Retired Leftovers:** already-clean items go under "Already clean (N)". | All filters, Recheck, the export, every rule, every setup step, every purge. |
| ☐ A6 | **Settings navigation:** four groups instead of seven (five of which hold one entry each). **Integrations:** Location Providers, Samsara, Samsara Video & Music, Dispatcher Board, Recruiters & Numbers, RingCentral Connection, Bitrix24, Facebook ↔ Bitrix. **AI:** the four sections from A1. **Telegram:** Where the Bot Posts, Group Access, Auto Reactions, Safety Approvals. **System:** Admin Accounts, Gross Grand Prix, Retired Leftovers. | Every section, and every key as an address. |

### B — Monitoring

| # | Change | Must not be lost |
|---|---|---|
| ☐ B1 | **System Health:** one "Needs a look" section first, across all groups (needs a person, stopped, failing, not reported). Each group follows as a one-line summary ("Engines: 21 working, 2 not reported") that expands into compact rows. The alert-delivery message is shown once, as that section's heading; its wording no longer claims that a RingCentral login problem is an alert-delivery problem. | Every row's reason and last error. "Not reported" is never shown as working. |
| ☐ B2 | **Needs Attention:** the intro becomes one line plus "How this works". The full configuration banner shows only on the findings tab; elsewhere it is one line with a link. **Automation:** the dry run comes first, the internal keys and migration notes sit behind a per-row "Details", and the switch and cap stack under the label on a phone. | The banner's content, every mode and cap, the preview. |

### C — Drivers

| # | Change | Must not be lost |
|---|---|---|
| ☐ C1 | **Driver Groups:** each row leads with the driver and unit, with the group title as a grey subtitle. A search box filters in the browser. Company chats show no driver Type or Unit controls. "AI: enrich" becomes a secondary button. On a phone each row is a card. | The duplicate and review flags, @username, every row editor, the driver modal. |
| ☐ C2 | **Home Time → Overview:** the changelog intro is replaced by one line. The tiles become one compact row. The screenshot import goes into a closed "Import from a screenshot" section. The driver popup shows each trip once (in the table, not also in the timeline). | The import's review step, the date editor, the evidence, "Still home". |
| ☐ C3 | **Home Time → Efficiency:** four headline numbers, the rest on one line, and the definitions behind "How is this calculated?". **Settings & Alerts:** three titled groups (Policy · Where notices go · Accounting alerts), one-line hints with "More", and a pointer to the road-bonus group's place. | The rules text, "empty = nothing posted", the Bitrix verdict. |
| ☐ C4 | **Live Locations:** the counts move onto the filter buttons and the count cards go. Each unit states its status once. On a phone the list comes before the map. | The provider-error banner, the diagnostics, every filter. |
| ☐ C5 | **Mileage Bonuses:** progress first, with the notification history collapsed as "History (N)". The per-driver switch reads "In bonus program / Excluded", because "Active/Inactive" means a different thing on Driver Groups. A link to where the bonus group is set. | Resend, Disregard, the confirm, Run check. |

### D — Recruiting

| # | Change | Must not be lost |
|---|---|---|
| ◐ D1 | **Customer Inquiries → Auto-Reply:** the editor on the left and one preview, kept in view, on the right. Order: basics → time rules → fallback → per-recruiter messages. The placeholder chips sit inside their card, and Save stays visible. On a phone the two-column grid stacks. | Every field and both previews' content (one place). |
| ◐ D2 | **Teach:** "Conversations Wenze is carrying" (the live stop control) moves to the top of the hours card, right under the open/closed line, instead of under every setting. The Teach card itself stays first on the tab, in the order the page documents (teach, then decide when). The auto-reply's hours are labelled "Greeting schedule", and both screens say in one line that the two kinds of hours are separate on purpose. | Every control. The two kinds of hours stay separate. |
| ☐ D3 | **Recruiter KPIs:** the new **Targets** tab (from A2). The targets summary becomes one line, and "Sync now" no longer wraps. | — |

### E — Communications

| # | Change | Must not be lost |
|---|---|---|
| ☐ E1 | **Send Message:** Broadcast History collapsed, its title showing the count and the failures. "Schedule for later" collapsed like Translations and Media, with its own button inside. The chosen audience is shown on the closed "Target groups" line. On a phone the preview sits above Send. **New survey:** Russian and Uzbek collapsed, opening by themselves after Translate or when Save is blocked. | Per-group delivery, Confirmation click tracking, the three-language rule. |
| ☐ E2 | **Messages:** Edit by Link becomes a "Have a message link?" section at the top of History (five tabs become four; `#communications/edit_by_link` lands there). On a phone, Scheduled is shown as cards. | Editing a message that is not in the log, the delete confirm. |
| ☐ E3 | **Birthdays:** the employee table first. "Add employee" opens the form. The send actions sit in a toolbar above the table. The posting time becomes one line with Change. | Every confirm, every send action, the settings. |

## Not in this plan

- Merging Birthdays' two employee tables (a behaviour change; see above).
- Moving Group Access out of Settings: `structure.md` already weighed it and
  kept it there.
- Any screen in the "fine" row above, beyond a fix named in a PR.
