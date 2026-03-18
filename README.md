# 🚛 Telegram Driver Feedback System

A Telegram bot-based feedback and communication system for trucking companies. Collects driver feedback, broadcasts announcements, runs employee voting polls, and processes Facebook leads — all managed through a web admin panel.

## Features

- **Telegram Bot** — Detects groups, registers drivers, sends multilingual questions, collects answers
- **Management Reporting** — All responses forwarded to management group in English
- **Multilingual** — English, Russian, Uzbek with AI-powered auto-translation (OpenAI)
- **Broadcast Messages** — Send announcements to all driver groups with multilingual support
- **Employee Voting** — "Driver of the Week" polls sent to employee group with inline buttons
- **Media Support** — Photo/video attachments (single or albums), above/below positioning
- **Leads-Bot** — Facebook/Meta lead capture via webhook (Python/FastAPI subprocess)
- **Admin Panel** — React-based web interface for groups, questions, broadcasts, voting, and responses
- **JWT Auth** — Secure admin panel with bcrypt + JWT

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
| `OPENAI_API_KEY` | OpenAI API key (enables auto-translation) |
| `PORT` | API server port (default: 3001) |
| `LEADS_BOT_PORT` | Leads-Bot internal port (default: 8000) |

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
│   └── employeeVoting.js        # Employee voting bot handlers
├── server/
│   ├── api.js                   # Express API server + leads-bot proxy
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

### Health
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/health` | No | Health check |
