# Production image for the whole hub: Telegram bot + Express API + admin SPA
# (index.js), and the Python leads worker it spawns as a child process.
# Built and run by Coolify on the Hostinger VPS; see
# docs/deployment/hostinger-coolify.md.
FROM node:20-bookworm-slim

# python3 for the leads-bot child, tini to reap it and forward signals,
# curl for the platform health check.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv tini curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The leads worker's dependencies live in a venv first on PATH, so the
# `python3` that index.js spawns is the one that has them.
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app

COPY leads-bot/requirements.txt leads-bot/requirements.txt
RUN pip install --no-cache-dir -r leads-bot/requirements.txt

# Dependencies before source, so a code-only change reuses these layers.
# --ignore-scripts skips the root postinstall (the admin build), which needs
# the source and runs explicitly below.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY admin/package.json admin/package-lock.json admin/
RUN npm ci --prefix admin

COPY . .
RUN npm run build --prefix admin \
  && rm -rf admin/node_modules \
  && npm prune --omit=dev --ignore-scripts

# The VPS has room the 512MB Render instance did not; override per deploy
# with NODE_OPTIONS in the platform's environment if needed.
ENV PORT=3001 \
    NODE_OPTIONS=--max-old-space-size=1024 \
    MALLOC_ARENA_MAX=2 \
    PYTHONUNBUFFERED=1

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "index.js"]
