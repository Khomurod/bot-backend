# 🚛 Telegram Driver Feedback System

A Telegram bot-based feedback system for trucking companies. Collects driver feedback across multilingual groups and reports to management.

## Features

- **Telegram Bot** — Detects groups, registers drivers, sends multilingual questions, collects answers
- **Management Reporting** — All responses forwarded to management group in English
- **Multilingual** — English, Russian, Uzbek
- **Admin Panel** — React-based web interface to manage groups, questions, and view responses
- **JWT Auth** — Secure admin panel with bcrypt + JWT

## Tech Stack

- **Backend:** Node.js, Telegraf, Express.js
- **Database:** PostgreSQL (Supabase / Neon compatible)
- **Frontend:** React + Vite

## Quick Start

### 1. Install dependencies

```bash
npm install
cd admin && npm install && cd ..
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

This starts both the Telegram bot and the API server on port 3001.

### Development mode (admin)

```bash
# Terminal 1: Start backend
npm start

# Terminal 2: Start admin dev server
cd admin && npm run dev
```

## Deployment (Render / Railway)

1. Set all environment variables in the platform dashboard
2. Build command: `npm install && cd admin && npm install && npm run build && cd ..`
3. Start command: `npm start`
4. After first deploy, run `npm run init-db` and `npm run seed-admin` via shell

## Project Structure

```
├── bot/bot.js           # Telegram bot (Telegraf)
├── server/api.js        # Express API server
├── database/
│   ├── schema.sql       # PostgreSQL schema
│   └── db.js            # Database helper
├── config/config.js     # Configuration
├── admin/               # React admin panel
│   └── src/
│       ├── App.jsx      # Main app component
│       ├── api.js       # API client
│       └── index.css    # Styles
├── scripts/
│   ├── init-db.js       # Database initializer
│   └── seed-admin.js    # Admin seeder
├── index.js             # Entry point
└── package.json
```

## API Endpoints

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | No | Admin login |
| GET | `/api/auth/verify` | Yes | Verify JWT |
| GET | `/api/groups` | Yes | List groups |
| PUT | `/api/groups/:id/language` | Yes | Set group language |
| GET | `/api/questions` | Yes | List questions |
| POST | `/api/questions` | Yes | Create question |
| POST | `/api/questions/:id/send` | Yes | Send to groups |
| PUT | `/api/questions/:id/deactivate` | Yes | Deactivate question |
| GET | `/api/responses/:questionId` | Yes | Get responses |
