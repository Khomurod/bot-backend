<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list. -->

# §10. Known limitations, retired features and intentional exceptions

- **The Trailer Department, Trailer Tracking and QBQ/SOS were removed
  (2026-09).** No `/trailers`, no `/questions`, no `/answers`, no `/qbq`, no
  trailer monitoring of driver-group messages, no trailer jobs, no trailer
  roles. Their tables were deliberately **not** dropped by the removal —
  Settings → Retired Leftovers is what clears them, on an administrator's
  explicit confirmation. See `docs/architecture/retired-trailers-qbq-sos.md`
  and `docs/ARCHIVED_FEATURES.md`.
- **FleetView is archived, not present.** No `fleet/`, no `server/fleet/`, no
  `/update` SPA, no `/api/v1/*`. It is preserved at the git tag
  `archive/fleetview-disabled`, its tables were deliberately **not** dropped, and
  **CI actively fails if it reappears** in the runtime. Treat any FleetView
  mention in older docs as historical. See `docs/ARCHIVED_FEATURES.md`.
  **`/updater` in this repository was never FleetView** — it was the "Updaters"
  department of the SOS questionnaire, which went with QBQ/SOS. The Telegram
  `/update` command is a live dispatcher ETA helper and is unrelated to both.
- **Retired features whose data was kept**: the driver location check-in /
  "Checked In / Checked Out" monitor (`driver_location_monitors`,
  `driver_location_checkins`), employee voting polls (`employee_votes*`), and the
  "Ask the Data" / "Chat Monitor" admin panels. See
  `docs/architecture/retired-*.md`.
- **`bot/locationCheckinHandlers.js` is a deliberate stub, not dead code.** The
  poller that sent check-in prompts is gone, so no new prompts exist — but the
  handler stays registered so a driver tapping an **old** button on an old message
  gets a "feature has been retired" alert instead of silence. Do not delete it
  while those messages still exist in Telegram history.
  **The removed trailer and QBQ features needed no equivalent**: neither ever
  produced an inline keyboard, and the `callback_query` catch-all already
  acknowledges unknown data without erroring.
- **A trailer-only admin account can still sign in and has nothing to open.**
  Its roles are gone from the seed but not from a database that already had
  them, so until Settings → Retired Leftovers is run the account authenticates
  and the panel tells it there are no sections available. That is deliberate:
  the alternative was a deploy silently deactivating logins.
- **`migrations/0001` references a design document that no longer exists**
  (`docs/superpowers/specs/…`). Left as-is on purpose: an applied migration is
  immutable, and editing even a comment makes the runner log a checksum-drift
  warning on every boot from then on. A dangling link in a comment is the
  cheaper problem.
- **No frontend type checking or lint.** The admin SPA is plain JS + Vite. Note
  that **`vite build` is not a syntax gate either**: a stray `)}` in JSX built
  clean and shipped the token as visible page text. `npm run lint:undef` is
  what catches it, which is one more reason it runs in CI.
- **Admin navigation is state-based**, not URL-router-based, except for the
  special-cased public paths (`/dispatch`, `/raise`, `/recruiters`) which
  `App.jsx` reads from `window.location`. Pages are lazy-loaded behind a
  chunk-error boundary.
- **Committed artifacts, not runtime logic**: `eng.traineddata` (Tesseract OCR
  data, used by the dispatch rate-confirmation PDF OCR) and `birthdays.csv`
  (read by `scripts/import-birthdays.js`). The old committed log snapshots and
  the `scratch/`, `brain/`, `reports/` and `.cursor/` working directories have
  been removed and gitignored — nothing in the application read them.
- **Files over 500 lines are all generated or third-party.** `database/schema.sql`
  is generated from `database/baseline/*.sql`; the two lockfiles are npm's;
  `eng.traineddata` is a binary OCR model. Every hand-written source, style,
  page and documentation file is at or under the limit, and
  `npm run lint:filesize` covers `.js/.jsx/.mjs/.cjs/.ts/.tsx/.py` plus
  `.css/.html/.md/.sql/.yml/.yaml` — 851 files. `.json` is the only source-like
  extension out of scope, and every JSON file over the limit is a lockfile.
- `package.json` declares `engines.node` twice (`>=20`, then `>=18.0.0` — the
  later wins). CI and Render both use Node 20.

---
