# After the admin redesign (PR #322)

Captured with the same local harness and crawler as `before/` (fictional data,
fake tokens, never production), on the PR's code at 1440×900 and 390×844.

- `desktop/`, `mobile/` — every page, tab, nested tab and the three modals.
- `inventory-*.json` — every visible button, link, field, table header and heading per screen.
- `parity-desktop.txt`, `parity-mobile.txt` — the screen-by-screen diff against `before/`.
  Desktop: identical except the Home Time Efficiency controls (rendered twice before, once now).
  Mobile: the same, plus the ☰ button (empty label) now labelled "Open menu" on every screen.
- `extra/` — dark theme (desktop and phone), the phone drawer, and an account without access.
- `public-before/`, `public-after/` — `/recruiters`, `/dispatch`, `/dispatchteam` on the old and
  the new build, light and dark OS: identical apart from the live clock (and the leaderboard's
  date-picker icon).
- `console-errors.json` — empty.

One later fix is not in these screenshots: on a phone, Needs Attention's finding names
(e.g. `home_time.board_disagrees_with_state`) break again so the severity stays in view
(commit 880f826 on the PR).
