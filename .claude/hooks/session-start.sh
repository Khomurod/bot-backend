#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Installs all dependencies needed to build the admin portal and run the
# test suite. Paths are resolved from this script's own location so the hook
# works no matter what the current working directory is when it runs
# (the previous external setup script failed because it ran
# `pip install -r leads-bot/requirements.txt` from the wrong directory).
set -euo pipefail

# Absolute path to the repository root (.claude/hooks/ -> repo root).
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_DIR"

echo "[session-start] Repo: $REPO_DIR"

# Node dependencies for the backend. The "postinstall" script also runs
# `npm ci --prefix admin && npm run build --prefix admin`, which installs the
# admin portal's deps and produces the production build.
echo "[session-start] Installing Node dependencies (backend + admin build)..."
npm install

# Python dependencies for the leads-bot service, exercised by `npm test`
# (python -m unittest discover -s leads-bot).
if [ -f leads-bot/requirements.txt ] && command -v pip3 >/dev/null 2>&1; then
  echo "[session-start] Installing leads-bot Python dependencies..."
  pip3 install -r leads-bot/requirements.txt
fi

echo "[session-start] Done."
