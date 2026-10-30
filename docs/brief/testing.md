<!-- Part of the App Brief. Read ../../APP_BRIEF.md first — it holds the
     purpose, the topology and the "must not break" list. -->

# §11. Testing and operational expectations

```bash
node --test --test-concurrency=1 tests/*.test.js   # Node suite (bash glob)
npm test                                          # gates + Node suite + Python leads tests
npm run build --prefix admin                      # admin production build
npm test --prefix admin                           # admin component tests
npm run lint:undef                                # undefined identifiers (the check a build is NOT)
npm run lint:imports                              # an import naming a missing export
npm run lint:filesize                             # 500-line limit
npm run build:schema:check                        # schema.sql is in sync with baseline/
```

- **The Node suite passes clean with no secrets and no database.** Verified
  baseline (2026-10-30, after the hidden-functions audit's first change, deps
  installed): the 378 non-`*Pg` files with no application env — **4007 tests,
  4007 pass, 0 fail** (the 702 `*Pg` tests in the same run skip without
  `TEST_DATABASE_URL`) — and the 96 `*Pg` files against a local PostgreSQL 16 —
  **754 tests, 754 pass, 0 fail, 0 skipped**. CI runs the non-`*Pg` files with
  no application env at all and the `*Pg` files against a real Postgres; both
  jobs fail on any skip. The admin suite is **482 pass in 65 files**; the
  Python leads tests are **81 pass**.
  **A test that pins `now` must pin every other clock it reads.** One pinned
  `now` to 2026-09-20 while the health code compared it with the REAL process
  boot time; on the day the real clock passed the pinned one the answer flipped,
  and every CI run after that was red for a reason no diff had touched. A boot
  time later than `now` now grants no grace, and the boot time is injectable.
  Without a database the `*Pg` suites skip instead — a skip is not a pass, so
  CI provides a real Postgres and fails on any skip.
  Two suites are END-TO-END SCENARIOS rather than unit tests, and are the
  ones to read first when a Phase 3 behaviour is in doubt:
  `tests/driverLifecycleScenarioPg.test.js` walks one driver through every
  system on a real database (seen → road → home → truck change → back out →
  old truck to a new driver → the watchdog places a quiet driver once allowed →
  restart), and
  `tests/aiLifecycleScenario.test.js` walks a provider through onboarding, a
  retired model, a dead key and a full outage through the real modules with the
  network replaced. The Python leads
  worker adds **60 tests**
  (`python -m unittest discover -s leads-bot -p "test_*.py"`; they need
  `pip install -r leads-bot/requirements.txt` first — without it all four test
  modules fail to import on `fastapi`, which is an unprepared environment and
  not a real failure). **So any failure is a real
  failure** — there is no "expected failures" allowance. *(An older internal doc
  claimed ~19 expected failures in a bare environment; that is no longer true and
  must not be used to excuse one.)* If
  you see mass failures, check `npm install` has run — a bare clone dies at
  `require('dotenv')`.
- **`*Pg.test.js` need `TEST_DATABASE_URL` and skip without it. A skipped test is
  not a passing test.** The harness creates a throwaway **database** per test
  (not a schema — `schema.sql` guards look up constraints by name with no schema
  filter) and applies the real, complete `schema.sql`. The database must be
  **UTF8** (`TEMPLATE template0`) because `schema.sql` contains box-drawing
  characters in comments.
- **CI** (`.github/workflows/ci.yml`) runs three jobs: static checks + admin
  build, the Node unit suite with **no application env at all**, and the
  PostgreSQL integration suite against a real Postgres 16 container.
  **Both test jobs fail on ANY skip.** CI also asserts FleetView stays archived.
  The CI PostgreSQL runs with `fsync`, `synchronous_commit` and
  `full_page_writes` off — it is thrown away with the job, and every test
  creates a database and applies the whole schema.
  The static job additionally runs `lint:undef` and `lint:imports` — the two
  checks a green build does not perform.
- **Run the suite before claiming success, and report the exact command and
  pass/fail counts.** Never claim a test passed that you did not run.
- **Prefer test endpoints over real sends** when validating manually:
  `POST /api/broadcast/test` (management group only),
  `POST /api/questions/send-test`. (The dispatch test hub,
  `DISPATCH_ETA_TEST_GROUP_ID`, went with the ETA updates on 2026-10-23.)
- **Never point a local process at production tokens or the production
  database.** `node index.js` with production env polls the production bot and
  sends real messages to real drivers.
- **Never print, log or commit a secret value.** Read-only secret scanning:
  `gitleaks dir . --redact` — report file and line only, never the value.