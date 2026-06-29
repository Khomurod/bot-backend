# 🚛 Telegram Driver Feedback System

A Telegram bot-based feedback and communication system for trucking companies. Collects driver feedback, broadcasts announcements, runs employee voting polls, and processes Facebook leads (via a separate WenzeLeadBots token) — all managed through a web admin panel.

## Features

- **Telegram Bot** — Detects groups, registers drivers, sends multilingual questions, collects answers
- **Management Reporting** — All responses forwarded to management group in English
- **Multilingual** — English, Russian, Uzbek with AI-powered auto-translation (OpenAI)
- **Broadcast Messages** — Send announcements to all driver groups with multilingual support
- **Scheduled Broadcasts** — One-time or weekly recurring sends in Central Time
- **Employee Voting** — "Driver of the Week" polls sent to employee group with inline buttons
- **Media Support** — Photo/video attachments (single or albums), above/below positioning
- **Leads-Bot (WenzeLeadBots)** — Facebook/Meta lead capture, auto-SMS, and RingCentral reply forwarding (Python verifier + Node worker on `TELEGRAM_BOT_TOKEN`)
- **Facebook Self-Serve Connect** — `/connect` in a leads Telegram group (WenzeLeadBots only) opens Facebook login, lets an admin choose Pages, and routes new leads into that group
- **Admin Panel** — React-based web interface for groups, questions, broadcasts, voting, and responses
- **JWT Auth** — Secure admin panel with bcrypt + JWT
- **Dispatch ETA (Wenze Feedback)** — `/location`, `/status`, `/load`, `/update` in driver groups; test hub interactive `/status` when `DISPATCH_ETA_TEST_GROUP_ID` is set

## Driver group commands (Wenze Feedback / `BOT_TOKEN`)

| Command | Where | Description |
|---|---|---|
| `/location` | Driver group | Live truck location pin + summary |
| `/status` | Driver group | Current load/ETA snapshot for that group |
| `/status` | **Automatic updating (Test)** hub (`DISPATCH_ETA_TEST_GROUP_ID`) | Bot asks for a driver name (first, last, or full); disambiguates duplicates; posts that driver's status into the hub |
| `/cancel` | Test hub (during lookup) | Cancels an in-progress `/status` name lookup |
| `/load` | Driver group | Resolved pickup/delivery context |
| `/update` | Driver group | Triggers immediate ETA update (if enabled for that group) |

Set `DISPATCH_ETA_TEST_GROUP_ID` to the Telegram chat id of **Automatic updating (Test)** (example production value: `-5289094495`).

## Datatruck peer bot (Wenze Feedback / `BOT_TOKEN`)

When `@datatruck_driver_bot` posts in an **active driver group**, `@wenzefeedback_bot` can:

- React with 👍 (and sometimes 🔥) to **load-related** messages
- Reply with a short **AI-generated playful roast** when Datatruck posts failure text (e.g. unknown command)

**Prerequisite:** Enable **Bot-to-Bot Communication Mode** for `@wenzefeedback_bot` in @BotFather (Bot settings). Privacy mode must remain **off** so Wenze receives group messages from other bots.

| Variable | Default | Description |
|---|---|---|
| `DATATRUCK_PEER_ENABLED` | `true` | Set `false` to disable reactions and banter |
| `DATATRUCK_PEER_BOT_USERNAME` | `datatruck_driver_bot` | Username of the peer bot (no `@`) |
| `DATATRUCK_LOAD_FLAME_CHANCE` | `0.35` | Probability of adding 🔥 on load messages |
| `DATATRUCK_BANTER_MAX_PER_HOUR_PER_CHAT` | `10` | Max reactions + roasts per driver group per hour |

Uses existing `GROQ_API_KEY` / `GEMINI_API_KEY` for banter text (fallback lines if AI unavailable).

## Mileage bonus workflow

The admin **Mileage Bonuses** page computes company-driver progress from the
Datatruck OpenAPI and sends milestone cards to the configured Telegram group.
Runs are serialized across instances and recorded in `mileage_bonus_runs`;
failed scheduled runs retry with exponential backoff.

- `Active` drivers are calculated and may receive new cards. Switching a
  driver to `Inactive` freezes the stored progress and disregards open cards.
- `Resend` creates a new current card, then removes the previous card and any
  tracked rejection follow-up. Paid bonuses cannot be resent.
- `Disregard` records an auditable terminal status and deletes the Telegram
  card. Telegram limits deletion of older messages; when deletion is refused,
  the bot removes the inline buttons so the task is no longer actionable.
- Configure immutable `MILEAGE_BONUS_ACCOUNTING_USER_IDS` in production.
  Username authorization is a compatibility fallback only when no IDs exist.

| Variable | Description |
|---|---|
| `DATATRUCK_API_TOKEN` | Read-only Datatruck OpenAPI token |
| `DATATRUCK_COMPANY` | Datatruck company subdomain |
| `MILEAGE_BONUS_GROUP_CHAT_ID` | Telegram destination for bonus cards |
| `MILEAGE_BONUS_ACCOUNTING_USER_IDS` | Comma-separated Telegram numeric IDs allowed to decide cards |
| `MILEAGE_BONUS_ACCOUNTING_USERNAMES` | Compatibility fallback usernames |

## Datatruck BOL/POD delivery

When a driver uploads a **Bill of Lading** or **Proof of Delivery** to
Datatruck, the bot forwards the file to that driver's Telegram group. A polling
service scans recently-delivered orders from the read-only Datatruck OpenAPI,
reads each order's inline `documents` array, matches the order to its driver
group (by **unit number** first, then **driver name**), and posts the document
with a short caption.

- **Idempotent:** every (order, document) pair is delivered at most once,
  guarded by a UNIQUE signature in `datatruck_document_deliveries`.
- **No backfill spam:** documents uploaded before the feature first activated
  (or before `DATATRUCK_DOC_SINCE`) are recorded as suppressed and never sent.
- **Retryable:** a failed send, or a document whose group does not exist yet,
  stays eligible for a later scan up to an attempt cap.

| Variable | Default | Description |
|---|---|---|
| `DATATRUCK_DOC_DELIVERY_ENABLED` | `true` | Set `false` to disable forwarding |
| `DATATRUCK_DOC_POLL_MINUTES` | `15` | How often to scan for new uploads |
| `DATATRUCK_DOC_LOOKBACK_DAYS` | `7` | How far back (by delivery time) to scan |
| `DATATRUCK_DOC_SINCE` | _(activation time)_ | ISO cutoff; documents uploaded before are treated as backfill |
| `DATATRUCK_DOC_MAX_FILE_MB` | `45` | Max size to download+upload when Telegram cannot fetch the URL itself |

## Tech Stack

- **Backend:** Node.js, Telegraf, Express.js
- **Database:** PostgreSQL (Supabase / Neon compatible)
- **Frontend:** React + Vite
- **Translation:** OpenAI GPT-4o-mini
- **Leads-Bot:** Python, FastAPI

## Quick Start

### 1. Install dependencies

```bash
npm install
cd admin && npm install && cd ..
pip install -r leads-bot/requirements.txt  # optional, for leads-bot
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Required variables:

| Variable | Description |
|---|---|
| `BOT_TOKEN` | Telegram bot token |
| `DATABASE_URL` | PostgreSQL connection string |
| `ADMIN_USERNAME` | Admin panel username |
| `ADMIN_PASSWORD` | Admin panel password |
| `MANAGEMENT_GROUP_ID` | Telegram management group ID |
| `JWT_SECRET` | Secret for JWT tokens |

Optional variables:

| Variable | Description |
|---|---|
| `EMPLOYEE_GROUP_ID` | Telegram employee group ID (enables voting) |
| `MEDIA_STORAGE_CHAT_ID` | Optional storage chat used to upload media and capture reusable `file_id`s |
| `OPENAI_API_KEY` | OpenAI API key (enables auto-translation) |
| `GROQ_API_KEY` | Groq API key (AI reports, insights, Ask Data, chat annotation, dispatch parsing) |
| `GROQ_AI_MODEL` | Optional Groq model for reports/insights (default: `llama-3.3-70b-versatile`) |
| `GROQ_AI_FAST_MODEL` | Optional fast Groq model for annotation batches (default: `llama-3.1-8b-instant`) |
| `GROQ_AI_FALLBACK_MODELS` | Comma-separated Groq models to try when one hits rate limits (limits are **per model**) |
| `ANNOTATOR_GROQ_MODELS` | Optional annotator-only Groq chain (defaults to fast model + `GROQ_AI_FALLBACK_MODELS`) |
| `ANNOTATOR_RATE_LIMIT_COOLDOWN_MS` | Pause between annotator batches when all Groq models return 429 (default: `15000`) |
| `GEMINI_API_KEY` | Google Gemini key (dispatch parsing, pinned-context; annotator fallback if Groq exhausted) |
| `GEMINI_TEXT_MODELS` | Gemini model chain, highest free-tier quota first (default starts with `gemini-3.1-flash-lite`) |
| `LOCATION_DRIVER_NAME_STRICT` | If `true`, `/location` blocks when Telegram group driver name does not match Samsara vehicle label (default: warn and still send pin) |
| `DISPATCH_ETA_TEST_GROUP_ID` | Telegram chat id for **Automatic updating (Test)** — receives test-mode ETA posts and interactive `/status` lookups |
| `DATATRUCK_PEER_ENABLED` | Enable 👍/🔥 reactions and AI banter for `@datatruck_driver_bot` in driver groups (default: on; set `false` to disable) |
| `DATATRUCK_PEER_BOT_USERNAME` | Peer bot username without `@` (default: `datatruck_driver_bot`) |
| `DATATRUCK_LOAD_FLAME_CHANCE` | `0`–`1` chance to add 🔥 on Datatruck load posts (default: `0.35`) |
| `DATATRUCK_BANTER_MAX_PER_HOUR_PER_CHAT` | Rate limit for peer reactions + roasts per driver group (default: `10`) |
| `PORT` | API server port (default: 3001) |
| `LEADS_BOT_PORT` | Leads-Bot internal port (default: 8000) |
| `RENDER_EXTERNAL_URL` | Public base URL used for `/connect` and webhook callbacks |
| `META_APP_ID` | Meta app id used for Facebook login |
| `META_APP_SECRET` | Meta app secret |
| `WEBHOOK_VERIFY_TOKEN` | Meta webhook verify token |
| `META_LOGIN_CONFIG_ID` | Optional Facebook Login for Business configuration id |
| `FACEBOOK_TOKEN_ENCRYPTION_KEY` | Secret used to encrypt stored Page tokens |
| `LEADS_INTERNAL_SHARED_SECRET` | Shared secret between Python webhook verifier and Node app |
| `TELEGRAM_BOT_TOKEN` | **WenzeLeadBots** token — `/connect`, lead alerts, connect confirmations |
| `TELEGRAM_CHAT_ID` | Telegram group id for **Wenze Facebook Leads** (RingCentral inbound SMS/MMS forwards and reply-to-SMS on those messages) |
| `BOT_TOKEN` | **Wenze Feedback** token — driver feedback only (not Facebook leads) |
| `BITRIX24_ENABLED` | Set `true` to also create CRM records in Bitrix24 when a Facebook lead arrives |
| `BITRIX24_WEBHOOK_URL` | Bitrix24 incoming webhook base URL (scope: `crm`), e.g. `https://wenze.bitrix24.com/rest/1/…/` |
| `BITRIX24_ENTITY` | `lead` (default) or `deal` — deals require `BITRIX24_DEAL_CATEGORY_ID` and `BITRIX24_DEAL_STAGE_ID` |
| `BITRIX24_STATUS_ID` | Optional lead stage override (e.g. `INCOMING`); also set in `config/bitrix24LeadFieldMap.json` |
| `BITRIX24_FIELD_MAP` | Optional JSON override for field mapping (`defaults`, `custom`, `statusId`) |
| `BITRIX24_FIELD_MAP_BY_FORM_ID` | Optional per-Facebook-form overrides keyed by form id |

### 3. Initialize database

```bash
npm run init-db
```

### 4. Seed admin user

```bash
npm run seed-admin
```

### 5. Build admin panel

```bash
cd admin && npm run build && cd ..
```

### 6. Start the system

```bash
npm start
```

This starts the Telegram bot, API server (port 3001), and Leads-Bot (Python) subprocess.

### Development mode

```bash
# Terminal 1: Start backend
npm start

# Terminal 2: Start admin dev server
cd admin && npm run dev
```

## Deployment (Render)

1. Set all environment variables in the Render dashboard
2. The `render.yaml` handles build and start commands automatically
3. Health check endpoint: `/api/health`
4. After first deploy, run `npm run init-db` and `npm run seed-admin` via shell

## Project Structure

```
├── index.js                     # Entry point (bot + API + leads-bot)
├── bot/
│   ├── bot.js                   # Telegram bot (Telegraf) — surveys, broadcasts
│   ├── dispatchStatusLookupHandlers.js  # Test hub interactive /status
│   ├── dispatchStatusLookupSession.js   # In-memory lookup sessions
│   └── employeeVoting.js        # Employee voting bot handlers
├── server/
│   ├── api.js                   # Express API server + leads-bot proxy
│   └── routes/facebookLeadsRoutes.js  # Admin API for lead auto-SMS config
│   └── employeeVotingApi.js     # Voting API routes
├── database/
│   ├── db.js                    # Database helpers (groups, drivers, questions)
│   ├── employeeVoting.js        # Voting database helpers
│   └── schema.sql               # PostgreSQL schema (auto-migrates on startup)
├── services/
│   └── translationService.js    # OpenAI translation service
├── config/
│   └── config.js                # Environment configuration
├── admin/                       # React admin panel (Vite)
│   └── src/
│       ├── App.jsx              # Main app component
│       ├── api.js               # API client
│       └── pages/FacebookLeadsPage.jsx  # Lead auto-SMS templates
│       └── index.css            # Styles
├── leads-bot/                   # Facebook leads processor (Python/FastAPI)
│   ├── main.py                  # Entry point
│   ├── webhook_server.py        # Webhook handler
│   ├── graph.py                 # Meta Graph API client
│   ├── sms.py                   # SMS notifications
│   └── config.py                # Python config
├── scripts/
│   ├── init-db.js               # Database initializer
│   ├── seed-admin.js            # Admin seeder
│   ├── migrate-media.js         # Media column migration
│   └── migrate-multi-media.js   # Multi-media migration
├── render.yaml                  # Render deployment config
└── package.json
```

## API Endpoints

### Auth
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | No | Admin login |
| GET | `/api/auth/verify` | Yes | Verify JWT |

### Groups
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/groups` | Yes | List driver groups |
| PUT | `/api/groups/:id/language` | Yes | Set group language (en/ru/uz) |

### Questions & Surveys
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/questions` | Yes | List all questions |
| GET | `/api/questions/:id` | Yes | Get question with options |
| POST | `/api/questions` | Yes | Create question |
| POST | `/api/questions/:id/send` | Yes | Send to all driver groups |
| POST | `/api/questions/send-test` | Yes | Send test preview to management |
| PUT | `/api/questions/:id/deactivate` | Yes | Deactivate question |
| GET | `/api/responses/:questionId` | Yes | Get responses |

### Broadcasts
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/broadcast/send` | Yes | Send broadcast to all groups |
| POST | `/api/broadcast/test` | Yes | Send test to management group |

### Translation
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/translate` | Yes | Translate text blocks (EN → RU/UZ) |

### Media
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/upload-media` | Yes | Upload photo/video to Telegram |

`/api/upload-media` must stage the file in a Telegram chat briefly so Telegram returns a reusable `file_id`. Set `MEDIA_STORAGE_CHAT_ID` to a private storage chat if you do not want uploads to use the management group. If `MEDIA_STORAGE_CHAT_ID` is not set, the app falls back to `MANAGEMENT_GROUP_ID`.

### Scheduled Messages
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/scheduled-messages` | Yes | Create a one-time or weekly recurring broadcast |
| GET | `/api/scheduled-messages` | Yes | List scheduled broadcasts and next run times |
| PUT | `/api/scheduled-messages/:id/send-now` | Yes | Send a scheduled broadcast immediately |
| PUT | `/api/scheduled-messages/:id/cancel` | Yes | Cancel a pending scheduled broadcast |

### Employee Voting
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/voting/units` | Yes | List driver units |
| GET | `/api/voting/polls` | Yes | List all polls |
| POST | `/api/voting/polls` | Yes | Create and send new poll |
| GET | `/api/voting/polls/:id/results` | Yes | Get poll results |
| GET | `/api/voting/polls/:id/voters` | Yes | Get voter list |
| PUT | `/api/voting/polls/:id/close` | Yes | Close active poll |
| PUT | `/api/voting/polls/:id/reset` | Yes | Reset all votes |

### Leads-Bot Proxy
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| ALL | `/webhook` | No | Facebook webhook (proxied to Python) |
| ALL | `/rc-webhook` | No | RingCentral webhook (proxied to Python) |

## Facebook Connect Flow

1. Configure the Meta app's Webhooks product to point at `https://YOUR-DOMAIN/webhook`
2. Make sure the Meta app can request the Page permissions you need, especially `leads_retrieval`, `pages_show_list`, `pages_read_engagement`, and `pages_manage_metadata`
3. Add **WenzeLeadBots** (`TELEGRAM_BOT_TOKEN`) to your **Wenze Facebook Leads** Telegram group
4. Set `TELEGRAM_CHAT_ID` on Render to that group's numeric chat id (supergroup ids look like `-100…`) so RingCentral SMS replies forward to the same group
5. In that group, a group admin sends `/connect` to **WenzeLeadBots** (not Wenze Feedback)
6. Click the button, sign in to Facebook, and select one or more Pages
7. New leads post to the connected Telegram group via WenzeLeadBots; after a successful auto-SMS, a notice is posted there: `AutoMessage sent via SMS to {phone}:` followed by the **exact SMS text** in monospace
8. **Reply in Telegram** to that notice (in the page group) or to an inbound **SMS/MMS Reply Received** in Wenze Facebook Leads (`TELEGRAM_CHAT_ID`) to send SMS via RingCentral (confirmation appears in-thread)

### Bitrix24 dual delivery (optional)

When `BITRIX24_ENABLED=true`, each Facebook lead is still sent to Telegram first, then synced to Bitrix24 via the incoming webhook (`crm.lead.add` by default). Bitrix failures are logged only — they do not block Telegram or webhook processing.

1. In Bitrix24 (`wenze.bitrix24.com`): **Developer resources → Incoming webhook** with `crm` scope
2. Set `BITRIX24_WEBHOOK_URL` to the webhook base (must end with `/` or the app normalizes it)
3. Discover field API names and **INCOMING** status id, then update `config/bitrix24LeadFieldMap.json`:

   ```bash
   BITRIX24_WEBHOOK_URL=https://wenze.bitrix24.com/rest/1/your-secret/ npm run discover-bitrix-fields
   ```

   Merge `statusId` and `UF_CRM_*` ids from `config/bitrix24LeadFieldMap.discovered.json` into `bitrix24LeadFieldMap.json`. Custom questions can use `matchTitle` hints until you paste explicit `bitrixField` names.

4. Redeploy with `BITRIX24_ENABLED=true`
5. Test with [Meta Lead Ads Testing Tool](https://developers.facebook.com/tools/lead-ads-testing/) or a live form on a connected Page (e.g. **ENglish Company Drivers - New One**, form id `1489274899611047`)
6. Confirm in **Leads → Incoming**: name, email, phone, and custom columns are on the lead card; **Comments** contains only tracking metadata (Page, Form ID, Leadgen ID)
7. Check Render logs for `[Bitrix24] Unmapped Meta field` and add keys to `custom` in the field map if needed

If Bitrix native Facebook Lead Ads forms are also active, the same Meta lead may appear twice in Bitrix — prefer this bot-backend path as the single CRM source until duplicates are ruled out.

### Lead auto-SMS templates (admin)

In the admin panel, open **Facebook Leads** to configure global automated SMS copy for new lead submissions:

- Edit message templates with clickable placeholders (`{first_name}`, `{phone}`, `{rep_name}`, etc.)
- Add **time rules** (e.g. Mon–Fri 08:00–17:00 → “Can I call you now?”) and a **fallback** message for outside those hours
- Preview the message that would send right now; view connected Pages and webhook log retries

SMS text is stored in the database and applied by the Node lead worker (not hardcoded in `.env`).

**Render checklist:** `BOT_TOKEN` ≠ `TELEGRAM_BOT_TOKEN`; `ENABLE_LEADS_BOT` is not `false`; deploy logs show `[LEADS-BOT] Starting Python process`.

### Health
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | No | Health check |
