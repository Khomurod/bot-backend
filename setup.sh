#!/usr/bin/env bash
# Repo setup for Claude Code on the web (and any fresh clone).
#
# SAFE TO RUN FROM ANY WORKING DIRECTORY. It resolves the repo root from this
# script's own location, so it never depends on the caller's CWD. This is the
# fix for the recurring web-session failure:
#   ERROR: Could not open requirements file:
#          [Errno 2] No such file or directory: 'leads-bot/requirements.txt'
# which happened because the environment setup script ran
# `pip install -r leads-bot/requirements.txt` from the PARENT directory
# (/home/user) where that relative path does not exist.
#
# Point the environment's "Setup script" at this file instead, e.g.:
#     bash bot-backend/setup.sh
# and the error can never come back — the path is resolved absolutely and the
# optional Python step is skipped (never failed) when it is not runnable.

# Do NOT use `set -e`: optional steps must not abort the whole session.
set -uo pipefail

# Absolute path to the repository root (this file lives at the repo root).
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"
echo "[setup] Repo: $REPO_DIR"

# ── Node dependencies (backend). The package.json "postinstall" also runs
#    `npm ci --prefix admin && npm run build --prefix admin`, installing the
#    admin portal deps and producing its production build. ──
echo "[setup] Installing Node dependencies (backend + admin build)..."
if ! npm install; then
  echo "[setup] WARNING: npm install failed — the session will still start; " \
       "run 'npm install' manually if you need the admin build or tests."
fi

# ── Python dependencies for the leads-bot service (exercised by `npm test`).
#    Fully optional: only runs when the requirements file AND pip both exist,
#    and a failure here never fails setup. The absolute path means CWD is
#    irrelevant. ──
REQ_FILE="$REPO_DIR/leads-bot/requirements.txt"
if [ -f "$REQ_FILE" ]; then
  PIP=""
  command -v pip3 >/dev/null 2>&1 && PIP="pip3"
  [ -z "$PIP" ] && command -v pip >/dev/null 2>&1 && PIP="pip"
  if [ -n "$PIP" ]; then
    echo "[setup] Installing leads-bot Python dependencies with $PIP..."
    "$PIP" install -r "$REQ_FILE" || echo "[setup] WARNING: leads-bot pip install failed (non-fatal)."
  else
    echo "[setup] pip not found — skipping optional leads-bot Python deps."
  fi
else
  echo "[setup] No leads-bot/requirements.txt — skipping optional Python deps."
fi

echo "[setup] Done."
# Always succeed: setup must never block a web session from starting.
exit 0
