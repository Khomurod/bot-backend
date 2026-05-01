import json
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

_DEFAULT_LEADS_TELEGRAM_TOKEN = "8626796769:AAE7e6PHADIlMnAOQNpnan196NYW007LyGc"

_CRED_JSON = Path(__file__).resolve().parent.parent / "config" / "metaAppCredentials.json"


def _meta_cred(key: str, default: str = "") -> str:
    try:
        data = json.loads(_CRED_JSON.read_text(encoding="utf-8"))
        v = data.get(key)
        return default if v is None else str(v)
    except Exception:
        return default


# Telegram (env overrides; default matches config/telegramBotTokens.js leadsBotToken)
TELEGRAM_BOT_TOKEN: str = os.environ.get("TELEGRAM_BOT_TOKEN", _DEFAULT_LEADS_TELEGRAM_TOKEN)
TELEGRAM_CHAT_ID: str = os.environ["TELEGRAM_CHAT_ID"]  # your personal chat id or group id

# Facebook / Meta (defaults from ../config/metaAppCredentials.json; env overrides)
WEBHOOK_VERIFY_TOKEN: str = os.environ.get(
    "WEBHOOK_VERIFY_TOKEN",
    "wenze-fb-webhook-verify",
)
META_APP_SECRET: str = os.environ.get("META_APP_SECRET", _meta_cred("metaAppSecret"))
META_PAGE_ACCESS_TOKEN: str = os.environ.get(
    "META_PAGE_ACCESS_TOKEN",
    _meta_cred("metaPageAccessToken"),
)
LOCAL_API_BASE_URL: str = os.environ.get("LOCAL_API_BASE_URL", f"http://127.0.0.1:{os.environ.get('PORT', '3001')}")
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
