# 🚛 Wenze Trucking Operations Hub (`bot-backend`)

A Telegram-bot and web platform for a trucking company: driver feedback and
surveys, broadcasts, dispatch and route operations, a trailer rental department,
recruiting and Facebook lead capture — all managed from a React admin panel.

This README is the **setup and operations entry point**. It deliberately does
not describe the features in depth.

| To understand… | Read |
|---|---|
| What the app is, who uses it, how features relate, what must not be broken | **[`APP_BRIEF.md`](APP_BRIEF.md)** — start here |
| How to work in this repository (rules, safety, testing) | [`CLAUDE.md`](CLAUDE.md) |
| The implementation workflow for a change | [`.claude/skills/implement/SKILL.md`](.claude/skills/implement/SKILL.md) — `/implement` |
| Which module owns what | [`docs/architecture/module-map.md`](docs/architecture/module-map.md) |
| The real HTTP surface | `server/api.js` (mounting order) and `server/routes/` |
| Database schema and migrations | [`docs/database/`](docs/database/) |
| Deployment checks | [`docs/deployment/pre-deploy-checklist.md`](docs/deployment/pre-deploy-checklist.md), `render.yaml` |

## Tech stack

- **Backend:** Node.js 20, Telegraf, Express
- **Database:** PostgreSQL (Supabase / Neon compatible)
- **Frontend:** React + Vite (plain JS, no type checking)
- **AI:** Groq with Gemini fallback (translation, classification, reports)
- **Leads bot:** Python, FastAPI

## Quick start

### 1. Install dependencies

```bash
npm install                                # also builds the admin panel (postinstall)
pip install -r leads-bot/requirements.txt  # optional, for the leads bot
```

### 2. Configure the environment

```bash
cp .env.example .env
```

**`.env.example` is the authoritative, commented list of every variable.** The
minimum needed to boot:

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Telegram bot token (Wenze Feedback) |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for admin JWTs |
| `MANAGEMENT_GROUP_ID` | Telegram management group ID |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Seeded admin panel credentials |

> `BOT_TOKEN` (Wenze Feedback) and `TELEGRAM_BOT_TOKEN` (WenzeLeadBots) are
> **different bots** — do not swap them.

Configuration is validated at the **startup boundary**, not at import time, so
modules can be unit-tested without any of it.

### 3. Initialize the database

```bash
npm run init-db
```

The schema is applied automatically on every boot: the generated baseline
`database/schema.sql` (built from `database/baseline/*.sql`) runs verbatim, then
any pending forward migrations in `database/migrations/`. **New schema changes go
in a forward migration** — `npm run migrate:new -- <name>`. Never hand-edit
`database/schema.sql`. See [`docs/database/migration-notes.md`](docs/database/migration-notes.md).

### 4. Seed the admin user and start

```bash
npm run seed-admin
npm start          # bot + API (port 3001) + leads-bot subprocess
```

Development mode:

```bash
npm start                    # terminal 1: backend
npm run dev --prefix admin   # terminal 2: admin dev server
```

## Development commands

```bash
node --test --test-concurrency=1 tests/*.test.js   # Node suite (bash glob)
npm test                                           # Node suite + Python leads tests
npm test --prefix admin                            # admin component tests
npm run build --prefix admin                       # admin production build
npm run lint:filesize                              # 500-line file-size limit
npm run build:schema                               # regenerate schema.sql from baseline/
npm run build:schema:check                         # verify it is in sync (CI gate)
npm run migrate / migrate:status / migrate:new     # forward migrations
npm run db:docs                                    # on-demand DB reference (needs a database)
```

The Node suite passes clean with **no secrets and no database**, so any failure
is a real failure. The `*Pg.test.js` integration tests skip without
`TEST_DATABASE_URL` — a skipped test is not a passing test. CI
(`.github/workflows/ci.yml`) fails on any skip.

## Deployment (Render)

1. Set every environment variable in the Render dashboard — deployment settings
   are never automated from this repository.
2. `render.yaml` supplies the build and start commands.
3. Health check: `/api/health`.
4. After the first deploy, run `npm run init-db` and `npm run seed-admin` from
   the shell.

Run through [`docs/deployment/pre-deploy-checklist.md`](docs/deployment/pre-deploy-checklist.md)
before shipping.

> **Pushing a feature branch to this repository auto-opens and auto-merges a PR
> into `main` within seconds.** Review the complete diff *before* pushing.

## Project layout

```
index.js                  Entry point — starts the bot, API, and leads-bot
bot/                      Telegraf handlers (handler order in bot.js is behavior)
server/
  api.js                  Express assembly + mounting order
  routes/                 One router per feature
services/                 Business logic; packages for large features
database/
  schema.sql              GENERATED baseline, applied on boot
  baseline/               Source segments for schema.sql
  migrations/             Run-once forward migrations
  <feature>.js            Queries (db.js is mostly a re-export seam)
admin/src/                React admin panel (pages, api client)
leads-bot/                Python FastAPI lead processor
scripts/                  Operational and maintenance scripts
tests/                    Node test suite (*Pg.test.js need a database)
docs/                     Architecture, database, deployment, feature docs
```
