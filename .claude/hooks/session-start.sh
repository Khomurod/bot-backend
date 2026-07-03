#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Installs everything needed to build the admin portal and run the test suite.
# All logic lives in the CWD-independent repo setup script (../../setup.sh) so
# there is ONE source of truth and setup can never fail from the wrong working
# directory (the historical cause of
#   "Could not open requirements file: 'leads-bot/requirements.txt'").
#
# NOTE: this hook runs during "Start Claude Code". The earlier "Ran setup
# script" step is the ENVIRONMENT's own setup script, configured in the web
# environment settings — point that at `bash bot-backend/setup.sh` (or leave it
# blank) so it uses this same safe script instead of a brittle relative path.

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bash "$REPO_DIR/setup.sh"
# Never let setup failures block the session from starting.
exit 0
