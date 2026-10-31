# Deployment: Hostinger VPS with Coolify

Since October 2026 the hub runs on a Hostinger VPS (KVM 2: 2 vCPU, 8 GB RAM,
Ubuntu 24.04) under [Coolify](https://coolify.io), which plays the part Render
used to: it watches `main`, builds, deploys, terminates TLS and restarts the
app. Render's free workspace was suspended after its 5 GB monthly bandwidth ran
out.

## How it is built

`Dockerfile` at the repository root is the whole recipe:

- `node:20-bookworm-slim` plus `python3` in a venv with
  `leads-bot/requirements.txt`, because `index.js` spawns the Python leads
  worker as a child process (`python3` on `PATH` is the venv's).
- `npm ci` for the backend, then the admin SPA is built into `admin/build`
  and dev dependencies are pruned.
- `tini` is PID 1 so the Python child is reaped and signals reach Node.
- A `HEALTHCHECK` curls `/api/health`.
- Defaults: `PORT=3001`, `NODE_OPTIONS=--max-old-space-size=1024`,
  `MALLOC_ARENA_MAX=2`. The 256 MB heap cap belonged to Render's 512 MB
  instance; an environment value set in Coolify overrides these.

## Coolify application settings

| Setting | Value |
|---|---|
| Source | GitHub `Khomurod/bot-backend`, branch `main`, auto-deploy on |
| Build pack | Dockerfile |
| Exposed port | `3001` |
| Domain | the hub's public `https://` domain |
| Health check | `/api/health` |
| Persistent storage | volume mounted at `/app/data` (the 4 PM celebration video, `data/gross-race/celebration.mp4`) |

The celebration video is never in the repository (it is public). Upload or
replace it, signed in to the admin panel as a full admin, with
`PUT /api/gross-race/video` (`Content-Type: video/mp4`); see
[`docs/architecture/gross-race.md`](../architecture/gross-race.md).

## Environment

Every variable the app reads is in `.env.example`; the required secrets are
named in `config/config.js`, and startup refuses without them. (The move off
Render in October 2026 copied them from the old service.) Then:

- **`RENDER_EXTERNAL_URL` must be set by hand** to the public `https://` URL.
  Render set it automatically; Coolify does not. The code keys off it for
  CORS (startup fails in production without an origin), the Facebook and
  RingCentral OAuth redirects, the RingCentral inbound-SMS subscription
  (`/rc-webhook`). (Route screenshot and raise-approval links used it too;
  both features were removed in October 2026.) It keeps its Render-era name on
  purpose: renaming it means changing the code and Coolify in the same deploy.
- Drop `NODE_OPTIONS=--max-old-space-size=256` if it came across from Render, or
  raise it: a `NODE_OPTIONS` set here overrides the `Dockerfile`'s 1024.

## When the public URL changes

Update, in this order: `RENDER_EXTERNAL_URL` (redeploy), the Meta app's
webhook callback (`/webhook`) and OAuth redirect (`/facebook/oauth/callback`),
the RingCentral app's redirect URI (`/ringcentral/oauth/callback`), the Indeed
Gmail Apps Script `ENDPOINT` (`/api/internal/indeed/lead`; Leads page shows
the script with the current address), and any screen showing `/dispatch` or
`/dispatchteam`.

## One poller per bot

Telegram allows a single long-polling consumer per token. Never run the app on
two hosts at once with the same `BOT_TOKEN` / `TELEGRAM_BOT_TOKEN` (409
Conflict on `getUpdates`).
