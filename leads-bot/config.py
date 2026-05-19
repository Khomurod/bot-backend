import os

from dotenv import load_dotenv

# On Render, secrets come from the dashboard — skip dotenv file parsing so a checked-in or
# stale .env cannot trigger "could not parse line …" warnings or override injected env.
if not os.environ.get("RENDER"):
    load_dotenv()

TELEGRAM_BOT_TOKEN: str = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID: str = os.environ["TELEGRAM_CHAT_ID"]  # your personal chat id or group id

WEBHOOK_VERIFY_TOKEN: str = os.environ.get("WEBHOOK_VERIFY_TOKEN", "")
META_APP_SECRET: str = os.environ.get("META_APP_SECRET", "")
META_PAGE_ACCESS_TOKEN: str = os.environ.get("META_PAGE_ACCESS_TOKEN", "")
# Node API port (not LEADS_BOT_PORT). On Render, PORT is the Express server.
_NODE_API_PORT = os.environ.get("PORT", "3001")
LOCAL_API_BASE_URL: str = os.environ.get(
    "LOCAL_API_BASE_URL",
    f"http://127.0.0.1:{_NODE_API_PORT}",
)
LEADS_INTERNAL_SHARED_SECRET: str = os.environ.get(
    "LEADS_INTERNAL_SHARED_SECRET",
    os.environ.get("JWT_SECRET", ""),
)

# Server
PORT: int = int(os.environ.get("LEADS_BOT_PORT", 8000))

# RingCentral SMS (optional — leave empty to disable)
RC_CLIENT_ID: str = os.environ.get("RC_CLIENT_ID", "")
RC_CLIENT_SECRET: str = os.environ.get("RC_CLIENT_SECRET", "")
RC_JWT_TOKEN: str = os.environ.get("RC_JWT_TOKEN", "")
RC_FROM_NUMBER: str = os.environ.get("RC_FROM_NUMBER", "")
