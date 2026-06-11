import os

from dotenv import load_dotenv

# On Render, secrets come from the dashboard — skip dotenv file parsing so a checked-in or
# stale .env cannot trigger "could not parse line …" warnings or override injected env.
if not os.environ.get("RENDER"):
    load_dotenv()

TELEGRAM_BOT_TOKEN: str = os.environ.get("TELEGRAM_BOT_TOKEN", "")
# Wenze Facebook Leads group — RingCentral inbound SMS/MMS forwards (same group as /connect)
TELEGRAM_CHAT_ID: str = os.environ["TELEGRAM_CHAT_ID"]

WEBHOOK_VERIFY_TOKEN: str = os.environ.get("WEBHOOK_VERIFY_TOKEN", "")
META_APP_SECRET: str = os.environ.get("META_APP_SECRET", "")
META_PAGE_ACCESS_TOKEN: str = os.environ.get("META_PAGE_ACCESS_TOKEN", "")
LOCAL_API_BASE_URL: str = os.environ.get("LOCAL_API_BASE_URL", "").strip()
LEADS_INTERNAL_SHARED_SECRET: str = os.environ.get(
    "LEADS_INTERNAL_SHARED_SECRET",
    os.environ.get("JWT_SECRET", ""),
)

# Server
PORT: int = int(os.environ.get("PORT", os.environ.get("LEADS_BOT_PORT", "8000")))

# RingCentral SMS (optional — leave empty to disable)
RC_CLIENT_ID: str = os.environ.get("RC_CLIENT_ID", "")
RC_CLIENT_SECRET: str = os.environ.get("RC_CLIENT_SECRET", "")
RC_JWT_TOKEN: str = os.environ.get("RC_JWT_TOKEN", "")
RC_FROM_NUMBER: str = os.environ.get("RC_FROM_NUMBER", "")
