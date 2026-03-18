import os
from dotenv import load_dotenv

load_dotenv()

# Telegram
TELEGRAM_BOT_TOKEN: str = os.environ["TELEGRAM_BOT_TOKEN"]
TELEGRAM_CHAT_ID: str = os.environ["TELEGRAM_CHAT_ID"]  # your personal chat id or group id

# Facebook / Meta
WEBHOOK_VERIFY_TOKEN: str = os.environ["WEBHOOK_VERIFY_TOKEN"]   # any secret string you choose
META_APP_SECRET: str = os.environ["META_APP_SECRET"]              # from Meta App dashboard
META_PAGE_ACCESS_TOKEN: str = os.environ["META_PAGE_ACCESS_TOKEN"]  # Page access token

# Server
PORT: int = int(os.environ.get("LEADS_BOT_PORT", 8000))

# RingCentral SMS (optional — leave empty to disable)
RC_CLIENT_ID: str = os.environ.get("RC_CLIENT_ID", "")
RC_CLIENT_SECRET: str = os.environ.get("RC_CLIENT_SECRET", "")
RC_JWT_TOKEN: str = os.environ.get("RC_JWT_TOKEN", "")
RC_FROM_NUMBER: str = os.environ.get("RC_FROM_NUMBER", "")
