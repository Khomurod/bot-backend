# The driver-raise review, and what is left of it

**Retired:** 2026-10, at the owner's request — "we no longer raise rates;
dispatchers are no longer asked." · **Pre-removal source:** any `main` commit
before this removal merged; the code is recoverable with `git log --diff-filter=D
-- services/raiseApprovalService.js`.

The driver-raise review decided, once a week, whether each company driver earned
the higher per-mile rate (`rate_high`, default 0.750) or stayed at the lower one
(`rate_low`, 0.720). Every Sunday Wenze rebuilt each dispatch team's roster from
the Dispatcher Board's dispatcher column, minted one round with one link, and
posted it to a dispatch Telegram group. A dispatcher opened the public `/raise`
page, picked their team, proved who they were with a one-time code (Gmail or
RingCentral SMS) and submitted their picks; the result went to a separate
accounting group.

This file also replaces `docs/architecture/driver-raise-roster.md`, which
described the Sunday roster rebuild, the dispatcher-name matcher and the
human-override rule. All of that went with the feature; what is still true about
the tables it wrote is below.

## What was removed

| | |
|---|---|
| `services/raiseApprovalService.js`, `services/raise/*` | the weekly round, Send now, the dispatcher flow, notifications, and the Sunday roster rebuild from the Board (`teamRoster.js`, `boardRoster.js`) |
| `services/otpService.js` | the Gmail / RingCentral one-time code for the public page |
| `database/raiseApproval.js` + `database/raiseApproval/*`, `lib/raise/*` (`dispatcherTeam.js`, `rosterPlan.js`) | the queries, the dispatcher-name matcher and the roster planner |
| `server/routes/raiseRoutes.js` (`/api/raise/*`, `/api/raise/admin/*`) | removed endpoints answer 404 like any unknown API path |
| The public `/raise` page | `/raise` and `/raise/*` answer **410 Gone** from `server/routes/retiredRoutes.js` — round links still sit in a Telegram group |
| Admin: Driver Raises (page key `raise_approval`), `RaisePublicPage`, `pages/raiseApproval/*`, `api/raise.js`, `styles/12-raise-public.css`, `pages/routeControlGroupSearch.mjs` | the last importer of Route Control's leftover helper went with this page |
| Background service `raise_approval` | gone from `lib/operations/backgroundServiceCatalog.js` and `services/backgroundServices.js` |
| Routing categories `dispatchReview` and `raiseResults` | `database/messageRoutingSettings.js` keeps only `mileageBonus` and `roadBonus`; config keys `dispatchReviewGroupId` / `raiseResultsGroupId` and env `DISPATCH_REVIEW_GROUP_CHAT_ID` / `RAISE_RESULTS_GROUP_CHAT_ID` are gone; Settings → Telegram Groups shows only the two bonus fields |
| Retention signal `raise_not_qualified` | see [`driver-retention.md`](driver-retention.md) |
| Users tab: the dispatch-team join | no "Dispatch team" column; the **Dispatchers** filter now means `bot_users.source = 'dispatcher'`; the opportunistic backfill of `dispatch_team_members.telegram_user_id` (`backfillDispatchMemberUserId`, called from `bot/handlers/groupCaptureHandlers.js`) is gone |
| Check `dispatch.team_driver_on_inactive_group` (was in `checks/systems.js`), and the findings `raise.driver_unplaced` / `raise.roster_not_rebuilt` the rebuild filed | |

The Dispatcher Board's identity checks, person links and panels were removed in
the same change. The Board itself stays, read only for Home Time's home-in /
home-out — see [`dispatcher-board.md`](dispatcher-board.md).

## What stayed, and why

- **The retired check keys.** `raise.driver_unplaced`, `raise.roster_not_rebuilt`
  and `dispatch.team_driver_on_inactive_group` are listed in
  `services/operations/checks/retired.js`, a check module that finds nothing.
  A finding resolves only when a sweep completes the module owning its key, so
  without that list every finding already open would stay open for ever.
  **`raise.progress_without_person` is NOT retired**: despite its prefix it is
  about mileage-bonus progress rows the person layer could not place, and it is
  still filed by `services/operations/checks/systems.js`.
- **The tables**, still created by `database/baseline/010_dispatch_teams.sql`
  and `011_raise_approval.sql` and read or written by nothing:
  `dispatch_teams`, `dispatch_team_drivers`, `dispatch_team_members`,
  `raise_settings`, `raise_rounds`, `raise_round_submissions`,
  `raise_round_picks`, `raise_otp`. They cannot simply stop being created:
  migrations 0026, 0058 and 0062 alter or update `dispatch_team_drivers`, and a
  fresh database runs them after the baseline. In production
  `dispatch_team_members` is empty and `dispatch_team_drivers` holds 49 rows.
  `raise_settings` may hold an encrypted Gmail App Password. Dropping them is a
  separate, deliberate step with a backup first.
- **Two routing columns.** `message_group_settings.dispatch_review_group_id` and
  `raise_results_group_id` remain and are unread. `lib/telegram/chatMigration.js`
  no longer rewrites them when a group is upgraded to a supergroup, and
  `tests/telegramChatMigration.test.js` lists them in `NOT_DESTINATIONS`.
- **Gmail environment variables.** `GMAIL_USER`, `GMAIL_APP_PASSWORD` and
  `GMAIL_FROM` are no longer read (`config/config.js` and `.env.example` dropped
  them). A deployment that still sets them is unaffected; they can be deleted
  from the host's environment.
- **History.** `raise_round_picks` and `raise_round_submissions` are the only
  record of past reviews; they were snapshots and nothing rewrote them.

`tests/removedFeaturesStayRemoved.test.js` fails if any of it comes back.
