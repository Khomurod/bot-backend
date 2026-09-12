# APP BRIEF — Wenze Trucking Operations Hub (`bot-backend`)

**This is the central brief for this application. Read it before any task, then
verify the specific parts you touch against the current source.** It is written
so an AI agent can build an accurate mental model in one read. It is deliberately
not exhaustive: it explains *what exists, why, and what must not break*, and
points at the code that holds the detail.

**This file holds what is worth reading every time**: the purpose, the
deployment topology, who uses it, the "must not break" list (§9), the testing
expectations and the file map. **The per-area sections (§4-§8, §10) are in
`docs/brief/`** — indexed below, numbering unchanged.

Companion documents: `CLAUDE.md` (mandatory working rules and per-feature
invariants — read it too), `README.md` (setup/endpoint reference),
`docs/` (deep dives, database reference, archived-feature records).

*Every claim below was verified against the code on **2026-09-07**. If you are
reading this much later, treat the specifics as likely-but-unconfirmed and
re-check what your task depends on — then update the date when you do.*

**How to read it:** §1–§3 (purpose, topology, users) and **§9 (what must not
break)** are worth reading every time — they are short and they are where the
expensive mistakes live, and they are all in this file. Then open the
`docs/brief/` part covering your task. §10 lists the traps, retired features
and stale docs; §12 is the file map.

---

## ⚠️ PERMANENT RULE — This brief is a living document

**Keeping this brief true is part of every task, not a separate chore.**
**"This brief" means this file AND `docs/brief/*` — they are one document, split
only because it outgrew the repository's 500-line file limit.**

1. **Before changing anything**, read the relevant sections here, then verify
   them against the current code. This brief can drift; the source is the truth.
   If you find drift, fix the brief as part of your task.
2. **After completing any** feature, bug fix, adjustment, removal, behavioral
   change, integration change, workflow change, permission change, or schema
   change — **re-read this brief** and ask: *does it still describe the
   application accurately?*
3. **If your work changed anything described here, update that part in the same
   task.** If you introduced an important behavior, rule, dependency,
   integration, exception, or decision, add it where it belongs. If something
   described here was removed or is no longer true, correct or delete it.
4. **A task is NOT complete while this brief says one thing and the application
   does another.** Treat a stale brief exactly like a failing test.
5. **Keep it useful.** Do not add minor implementation details, line numbers,
   function signatures, or anything that will rot without adding understanding.
   Add a fact here only if a future agent would make a mistake without it.

The same applies to the per-feature invariants in `CLAUDE.md` — if you change a
behavior it guards, update it there too.

---
## 1. App purpose

A **trucking operations and driver-communication platform** for **Wenze
Investments**, a US trucking company. It is the company's internal operations
hub, and almost everything it does reduces to one of two actions:

- **send/receive Telegram messages to and from driver and staff groups**, or
- **read/write the shared PostgreSQL database.**

Follow those two threads and you will find any feature.

Business problems it solves:

- Communicate with drivers at scale, in their own language (EN/RU/UZ), through
  the Telegram groups they already live in.
- Give dispatch real-time truck location, load and ETA information.
- Automate recurring operations work: bonuses, raises, home-time, fuel stops,
  document forwarding, off-route warnings, birthday wishes.
- Capture and convert recruiting leads (Facebook/Meta, Indeed) and measure
  recruiter performance.

---
## 2. Deployment topology and processes

`render.yaml` defines two Render services in this repo; a third lives elsewhere.

| Service | Repo | What it is |
|---|---|---|
| `driver-feedback-bot` | this repo | `index.js` — the whole Node app: Telegram bot + Express API + admin SPA + all background jobs |
| `facebook-leads-engine` | this repo (`leads-bot/`) | Python FastAPI lead worker. In the main deployment `index.js` **spawns it as a child process**; it can also run standalone |
| Samsara safety poller | **separate repo** `Khomurod/samsara-integration` | Polls Samsara safety events → dashcam alerts to Telegram |
| Dispatcher Board | **not a service of ours** — an external Google Apps Script web app over the dispatchers' spreadsheet | Read-only, polled. **The authority on a driver's current assignment**; Wenze stays the authority on who a person permanently is. Off until a URL and token are saved in Settings |

The three cooperate in **two different ways** — do not confuse them:

- **Node hub ↔ Samsara service: shared PostgreSQL only.** Same `DATABASE_URL`,
  no in-process link and no HTTP link between them. The Samsara service reads
  `groups` for driver-group routing, the safety-event video/music settings and
  the `samsara_settings` row this repo manages, and writes
  `safety_event_video_jobs` and `samsara_video_recovery_jobs`.
  **That table IS the configuration channel.** Settings → Samsara is where the
  Samsara API key, missing-video recovery and its delays are set; the poller
  picks them up within a minute. Do not add an HTTP link between the two
  services to exchange settings — the shared database already solves it, and a
  second channel is a second thing to get out of step.
- **Node hub ↔ Python leads worker: internal HTTP only.** The worker has **no
  database access whatsoever** — no Postgres driver in
  `leads-bot/requirements.txt`, no `DATABASE_URL` (and `render.yaml` does not
  give it one). It calls the hub at `LOCAL_API_BASE_URL` with
  `LEADS_INTERNAL_SHARED_SECRET`, and the hub proxies `/webhook` + `/rc-webhook`
  to it. **All lead persistence happens on the Node side.**

Hard constraints of this deployment:

- **Memory-constrained.** The Node process runs with `--max-old-space-size=256`
  on a 512MB instance, `MALLOC_ARENA_MAX=2`, and a Postgres pool of `max=5`.
  Avoid buffering large files, unbounded caches, and new always-on intervals.
  `services/memoryWatchdog.js` can log pressure but is **off unless
  `MEMORY_WATCHDOG_ENABLED='true'`**.
- **The Samsara poller was moved out of this process on purpose** — it caused
  OOM kills. **Do not re-add it here.** The live-GPS lookup that remains in this
  app is a different, much smaller thing and must keep working. See
  `docs/architecture/samsara-separation.md`.
- **All Telegram traffic is pinned to IPv4** via `services/telegramAgent.js`.
  The host's IPv6 path to `api.telegram.org` black-holes multi-packet upload
  bodies. **Do not remove that agent.**
- The Python child is supervised with exponential-backoff restart and a
  **circuit breaker** (5 crashes in 3 minutes → stop restarting; exit code 78 =
  permanent config error, never restarted).
- `main` auto-deploys to Render. A push opens and merges nothing by itself —
  the agent opens the PR, the repository owner merges it — but the owner may
  merge at any moment, so **review the complete diff BEFORE pushing**
  (`CLAUDE.md`).

### The Telegram bots

| Bot | Token env | Role | Owner |
|---|---|---|---|
| Wenze Support / feedback bot | `BOT_TOKEN` | Main bot: feedback, broadcasts, dispatch commands, Route Control, home time, bonuses, creator panel | this repo, `bot/` |
| Wenze lead bot | `TELEGRAM_BOT_TOKEN` | Facebook/Indeed leads, auto-SMS, RingCentral replies | `leads-bot/` + `services/leadsTelegramClient.js` |
| Samsara notification bot | `SAMSARA_BOT_TOKEN` (in the other repo) | Dashcam safety alerts | `samsara-integration` |

- **Only long-polling must be exclusive** — a token may be *sent* on from
  anywhere, but only one process may `getUpdates` it. Two pollers on one token
  produce a permanent Telegram 409 conflict loop, so
  `assertDistinctTelegramPollingTokens()` in `index.js` refuses to boot if
  `BOT_TOKEN === TELEGRAM_BOT_TOKEN`.
- Consequently: the **Python worker polls** `TELEGRAM_BOT_TOKEN` while Node only
  *sends* on it (`services/leadsTelegramClient.js`), and the **Samsara service
  sends** on the hub's `BOT_TOKEN` (to post into driver groups) while only the
  hub polls it. Both are safe; adding a second poller anywhere is not.
- `@datatruck_driver_bot` is a **third-party** bot ours only reacts to
  (`bot/datatruckPeerHandlers.js`).

---
## 3. Main users

| User type | How they use it |
|---|---|
| **Drivers** | Their Telegram driver group is the whole interface: answer surveys, post `Status: Home/Ready/Rolling`, request home time, receive broadcasts, bonuses, route/off-route warnings, BOL/POD documents, fuel reminders. Also anonymous feedback in the bot's private chat. |
| **Dispatchers** | `/load`, `/location`, `/status`, `/update` inside driver groups; assign Google Maps routes (Route Control) by pasting a directions link; receive automatic ETA updates; submit their team's weekly driver-raise picks through the public raise link. |
| **Admins / office staff** | The admin SPA at `/admin`: broadcasts, surveys, groups, leads, live map, home time, fuel, mileage bonuses, raises, recruiter KPIs, settings. |
| **Accounting** | Mileage-bonus Paid/Rejected buttons in Telegram (allow-listed accounting users — see §5); the driver-raise results group. |
| **Recruiters** | Measured, not users: RingCentral call logs feed KPIs and the public `/recruiters` leaderboard. |
| **The owner ("creator")** | A Telegram-only messaging panel in the bot's private chat, gated on one numeric user ID (`CREATOR_USER_ID` in `bot/creatorMessageManager.js`). Also **steers Wenze from the notifications group**: it asks one plain question per open finding it could fix but has not been permitted to, and a reply — *yes*, *no* and why, or *later* — applies, closes or postpones it, and a "no" is remembered so the same situation is not asked about again. Only accounts on the `control_operators` allow-list are obeyed. |

---
## The rest of the brief

The sections below moved into `docs/brief/` when this file passed the
repository's 500-line limit. **Nothing was dropped** — the numbering is
unchanged, so a reference to "§7" still means the same section.

| Section | Read it when |
|---|---|
| [§4. Features and workflows](docs/brief/features.md) | You are touching any feature: driver comms, dispatch, payroll-adjacent flows, the Finance Monitor, fuel, the Groups page, the presenter remote |
| [§4b. Home time](docs/brief/home-time.md) | You are touching home time: the home/road state machine, the three manager notices, request detection, automatic return-to-road detection, the cycle invariant |
| [§4c. Recruiting and leads](docs/brief/recruiting.md) | The Facebook lead chain, whose number texts a candidate, after-hours answering, Teach Wenze, Customer Inquiries, recruiter KPIs |
| [§4a. The system checking itself, and the AI that helps](docs/brief/self-checking-and-ai.md) | Operational findings, tiered corrections, the audit trail |
| [§4b. The AI routing layer, and what AI is allowed to decide](docs/brief/ai-gateway.md) | The provider roster, per-responsibility switches, what a model may and may not say |
| [§4c. The AI provider terms watcher](docs/brief/ai-terms-watcher.md) | You are touching the provider terms watcher: its schedule, its diffing, or what may pause a provider |
| [§5. Permissions and access rules](docs/brief/permissions.md) | Auth, roles, permissions, or any route that is *not* behind the admin JWT |
| [§6. Integrations and configuration](docs/brief/integrations.md) | Telegram, Datatruck, Samsara/ELD, Google Maps, Meta, RingCentral, Bitrix, the AI providers, or where a setting lives |
| [§7. Automatic and background behavior](docs/brief/background-jobs.md) | Anything on a timer, the database transfer budget, browser polling, or an idempotency ledger |
| [§7a. The rules every background job obeys](docs/brief/background-job-rules.md) | Whether a worker actually ran, the shared fleet snapshot, data retention, and why nothing is heard until a notification destination is set |
| [§8. Data model and cross-feature relationships](docs/brief/data-model.md) | Schema, migrations, `groups`, or what else a table change touches |
| [§9a. Code-structure rules](docs/brief/code-structure.md) | The 500-line cap, `lint:undef` / `lint:imports`, the façade rule, one-way dependencies |
| [§9. Decisions and behavior that must be preserved](docs/brief/invariants.md) | Before changing anything that looks load-bearing — the invariants, each with the test that guards it |
| [§10. Known limitations, retired features and intentional exceptions](docs/brief/limitations.md) | Something looks wrong, missing or stale — check here before "fixing" it |
| [§11. Testing and operational expectations](docs/brief/testing.md) | Which commands to run, the verified test baseline, the test endpoints, the operational safety rules |

---

## 9. Decisions and behavior that must be preserved

**Moved to [`docs/brief/invariants.md`](docs/brief/invariants.md)** — the
highest-consequence invariants, each with the test that guards it. Part of this
brief, split out when this file reached the 500-line limit with no room left to
record another one. The section number is unchanged: a reference to "§9" still
means the same list.

The full per-feature rules live in `docs/architecture/*.md`; `CLAUDE.md` links
to them and holds the repository-wide working rules.

---
## 11. Testing and operational expectations

**Moved to [`docs/brief/testing.md`](docs/brief/testing.md)** — the commands,
the verified test baseline, the test endpoints and the operational safety rules.
Part of this brief, split out for the same reason §9a was: a section that grows
by a number on every stage does not belong in the file everything else fits in.

---
## 12. Where to look next

| Need | Go to |
|---|---|
| Config, defaults, feature flags | `config/config.js` — read this first |
| Process orchestration, job startup, shutdown | `index.js` |
| HTTP mounting order and route inventory | `server/api.js` |
| Auth and permission middleware | `server/middleware/auth.js` |
| A feature's HTTP surface | `server/routes/<feature>Routes.js` |
| Business logic | `services/` — one concern per file, packages for large features |
| Queries | `database/<feature>.js` (`db.js` is only the re-export seam) |
| Schema (authoritative) | `database/baseline/*.sql` (source) → `database/schema.sql` (generated); new work in `database/migrations/` |
| Admin UI | `admin/src/App.jsx`, `admin/src/pages/`, `admin/src/api/` |
| Telegram handlers and send helpers | `bot/bot.js` (order!), `bot/handlers/`, `bot/senders.js` |
| Any brief section not in this file | `docs/brief/` (see the index above) |
| How to work in this repo (rules, safety, testing) | `CLAUDE.md` |
| The implementation workflow | `.claude/skills/implement/SKILL.md` (`/implement`) |
| Route Control + media-transport invariants | `docs/architecture/route-control.md` |
| Whose number texts a lead, WHICH message they send, and the RingCentral/TCR prerequisites | `docs/architecture/recruiter-sms-sender.md` |
| Samsara settings (the shared `samsara_settings` row, the shared-secret envelope for its API key) and missing-video recovery | `docs/architecture/samsara-settings-and-video-recovery.md` |
| Database: authoritative schema + migration rules | `database/baseline/`, `database/migrations/`, `docs/database/` |
| What was removed and why | `docs/ARCHIVED_FEATURES.md`, `docs/architecture/retired-*.md`, `docs/architecture/samsara-separation.md` |
| Clearing a removed feature's leftover tables and roles | Settings → Retired Leftovers; `database/retiredLeftovers.js` |
| Deployment checks | `docs/deployment/pre-deploy-checklist.md`, `render.yaml` |

### Working conventions

CommonJS, one concern per service file, `console.*` with a structured prefix
(`[API]`, `[BOT]`, `[DB]`, `[SCHEDULER]`, `[LEFTOVERS]`, …), additive SQL only, and
a test in `tests/` for whatever you changed. Match the surrounding code.
**When in doubt about production impact, stop and ask rather than guessing** —
and if a behavior is genuinely ambiguous, say so instead of inventing it.
