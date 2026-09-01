"""
FastAPI webhook server.
- GET  /webhook          → Facebook verification challenge
- POST /webhook          → Receive lead notifications + Messenger messages
- POST /rc-webhook       → RingCentral incoming SMS notifications
- GET  /health           → Render health check
- GET  /retry/{lead_id}  → Re-fetch and resend a failed lead
"""
import asyncio
import hashlib
import hmac
import html
import json
import logging
import mimetypes
import os
import time
from collections import OrderedDict
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse, Response

from config import (
    LEADS_INTERNAL_SHARED_SECRET,
    LOCAL_API_BASE_URL,
    META_APP_SECRET,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    WEBHOOK_VERIFY_TOKEN,
)
from graph import fetch_lead, format_lead_message, fetch_sender_profile, format_messenger_message
from sms import download_ringcentral_attachment, register_sms_webhook, send_sms

import httpx

logging.basicConfig(level=logging.INFO)
# Avoid logging full Telegram URLs (they embed the bot token) at INFO.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

app = FastAPI(title="Leads Webhook")

# ── Data directory for persistent files ──────────────────────
DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)

LEADS_LOG_FILE = DATA_DIR / "leads_log.json"
SEEN_SENDERS_FILE = DATA_DIR / "seen_senders.json"

# ── Public base URL (for RingCentral webhook callback) ────────
BASE_URL = os.environ.get("RENDER_EXTERNAL_URL", "https://bot-backend-x9lc.onrender.com")
TELEGRAM_API_BASE = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"
CONNECT_COMMAND_POLL_TIMEOUT = 50
CONNECT_COMMAND_ALLOWED_UPDATES = ["message"]
_connect_command_task: asyncio.Task | None = None
_connect_command_stop = asyncio.Event()
_telegram_update_offset: int | None = None
_telegram_bot_username: str = ""

# ── De-duplication: track seen Messenger senders ──────────────────
# File-backed OrderedDict — survives restarts.
MAX_SEEN = 5000
_seen_senders: OrderedDict[str, bool] = OrderedDict()


def _load_seen_senders():
    """Load seen senders from disk on startup."""
    global _seen_senders
    try:
        if SEEN_SENDERS_FILE.exists():
            data = json.loads(SEEN_SENDERS_FILE.read_text())
            _seen_senders = OrderedDict((k, True) for k in data[-MAX_SEEN:])
            logger.info("Loaded %d seen senders from disk.", len(_seen_senders))
    except Exception as exc:
        logger.warning("Could not load seen senders (will start fresh): %s", exc)


def _save_seen_senders():
    """Persist seen senders to disk."""
    try:
        SEEN_SENDERS_FILE.write_text(json.dumps(list(_seen_senders.keys())))
    except Exception as exc:
        logger.warning("Could not save seen senders: %s", exc)


def _is_new_sender(sender_id: str) -> bool:
    """Return True if this sender hasn't messaged before (first contact)."""
    if sender_id in _seen_senders:
        _seen_senders.move_to_end(sender_id)
        return False
    _seen_senders[sender_id] = True
    while len(_seen_senders) > MAX_SEEN:
        _seen_senders.popitem(last=False)
    _save_seen_senders()
    return True


# ── Leads log: persistent record of every lead received ──────
def _log_lead(leadgen_id: str, status: str, detail: str = ""):
    """Append a lead entry to the persistent log file."""
    try:
        entries = []
        if LEADS_LOG_FILE.exists():
            try:
                entries = json.loads(LEADS_LOG_FILE.read_text())
            except Exception:
                entries = []
        entries.append({
            "leadgen_id": leadgen_id,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "status": status,
            "detail": detail,
        })
        # Keep last 5000 entries to prevent unbounded growth
        if len(entries) > 5000:
            entries = entries[-5000:]
        LEADS_LOG_FILE.write_text(json.dumps(entries, indent=2))
    except Exception as exc:
        logger.warning("Could not write leads log: %s", exc)


# Load seen senders on module import
_load_seen_senders()


def _verify_signature(payload: bytes, signature_header: str) -> bool:
    """Validate X-Hub-Signature-256 header from Facebook."""
    if not signature_header.startswith("sha256="):
        return False
    expected = hmac.new(
        META_APP_SECRET.encode(),
        payload,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature_header[7:])


async def _forward_verified_facebook_payload(payload: dict) -> dict:
    """Hand verified Facebook payloads to the main Node app for durable processing."""
    if not LEADS_INTERNAL_SHARED_SECRET:
        raise RuntimeError("LEADS_INTERNAL_SHARED_SECRET is not configured")

    url = f"{LOCAL_API_BASE_URL.rstrip('/')}/api/internal/facebook/webhook-events"
    headers = {"x-internal-shared-secret": LEADS_INTERNAL_SHARED_SECRET}
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, json=payload, headers=headers)
        if not resp.is_success:
            raise RuntimeError(f"Internal Facebook ingest failed ({resp.status_code}): {resp.text[:500]}")
        return resp.json()


async def _forward_retry_leadgen_to_node(leadgen_id: str) -> dict:
    """Re-queue a lead through the Node worker (uses admin-configured SMS templates)."""
    if not LEADS_INTERNAL_SHARED_SECRET:
        raise RuntimeError("LEADS_INTERNAL_SHARED_SECRET is not configured")

    url = f"{LOCAL_API_BASE_URL.rstrip('/')}/api/internal/facebook/retry-leadgen"
    headers = {"x-internal-shared-secret": LEADS_INTERNAL_SHARED_SECRET}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json={"leadgenId": leadgen_id}, headers=headers)
        if resp.status_code == 404:
            return {"status": "not_found"}
        if not resp.is_success:
            raise RuntimeError(f"Internal lead retry failed ({resp.status_code}): {resp.text[:500]}")
        return resp.json()


async def _telegram_api_call(method: str, payload: dict) -> dict:
    """Call a Telegram Bot API method and return the parsed result object."""
    url = f"{TELEGRAM_API_BASE}/{method}"
    if method == "getUpdates":
        tg_long_poll = int(payload.get("timeout") or 0)
        # HTTP client must outlive Telegram's long-poll (up to 50s); a 20s read timeout causes ReadTimeout.
        read_seconds = float(tg_long_poll) + 25.0 if tg_long_poll else 30.0
        read_seconds = min(max(read_seconds, 25.0), 120.0)
        timeout = httpx.Timeout(connect=15.0, read=read_seconds, write=20.0, pool=15.0)
    else:
        timeout = httpx.Timeout(connect=15.0, read=25.0, write=20.0, pool=15.0)

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, json=payload)
        data = json.loads(resp.text, strict=False) if resp.text else {}
        if not resp.is_success or not data.get("ok"):
            description = data.get("description") or resp.text[:300]
            raise RuntimeError(f"Telegram {method} failed ({resp.status_code}): {description}")
        return data.get("result", {})


async def _delete_leads_bot_webhook() -> None:
    """Drop any webhook so getUpdates long-polling is allowed (same idea as the main Node bot)."""
    if not TELEGRAM_BOT_TOKEN:
        return
    try:
        await _telegram_api_call("deleteWebhook", {"drop_pending_updates": False})
        logger.info("Leads bot deleteWebhook OK (polling mode).")
        await asyncio.sleep(0.4)
    except Exception as exc:
        logger.warning("Leads bot deleteWebhook failed (continuing): %s", exc)


def _leads_hub_chat_id_candidates() -> set[str]:
    """Chat id forms Telegram may use for the same Wenze Facebook Leads supergroup."""
    raw = str(TELEGRAM_CHAT_ID).strip()
    candidates = {raw}
    if raw.startswith("-100"):
        candidates.add(f"-{raw[4:]}")
    elif raw.startswith("-") and not raw.startswith("-100"):
        candidates.add(f"-100{raw[1:]}")
    return candidates


def _is_leads_hub_chat(chat_id: int | str) -> bool:
    return str(chat_id).strip() in _leads_hub_chat_id_candidates()


async def _send_telegram_to_chat(
    chat_id: str | int,
    text: str,
    *,
    parse_mode: str | None = None,
    reply_markup: dict | None = None,
    reply_to_message_id: int | None = None,
) -> int | None:
    """Send a Telegram message to an arbitrary chat with optional inline keyboard."""
    payload = {
        "chat_id": str(chat_id),
        "text": text,
    }
    if parse_mode:
        payload["parse_mode"] = parse_mode
    if reply_markup:
        payload["reply_markup"] = reply_markup
    if reply_to_message_id is not None:
        payload["reply_to_message_id"] = reply_to_message_id

    for attempt in range(2):
        try:
            result = await _telegram_api_call("sendMessage", payload)
            return result.get("message_id")
        except Exception as exc:
            if attempt == 0 and parse_mode:
                payload.pop("parse_mode", None)
                continue
            if attempt == 0:
                await asyncio.sleep(2)
                continue
            logger.error("Telegram sendMessage to chat %s failed: %s", chat_id, exc)
            return None
    return None


async def _bootstrap_connect_command_offset():
    """Skip any stale backlog so only fresh /connect commands are handled."""
    global _telegram_update_offset
    payload = {
        "timeout": 0,
        "limit": 100,
        "allowed_updates": CONNECT_COMMAND_ALLOWED_UPDATES,
    }
    try:
        updates = await _telegram_api_call("getUpdates", payload)
        if updates:
            _telegram_update_offset = max(update["update_id"] for update in updates) + 1
    except Exception as exc:
        logger.warning("Could not bootstrap Telegram update offset for leads bot: %s", exc)


async def _load_telegram_bot_profile():
    """Fetch bot username so /connect@ThisBot works in groups."""
    global _telegram_bot_username
    try:
        me = await _telegram_api_call("getMe", {})
        _telegram_bot_username = str(me.get("username", "")).lower()
        if _telegram_bot_username:
            logger.info("Leads bot Telegram username detected: @%s", _telegram_bot_username)
    except Exception as exc:
        logger.warning("Could not load leads bot Telegram profile: %s", exc)


def _extract_connect_command(text: str) -> bool:
    """Return True when text is a /connect command for this bot."""
    first_token = str(text or "").strip().split()[0] if text else ""
    if not first_token.startswith("/connect"):
        return False
    if "@" not in first_token:
        return first_token == "/connect"
    command, mentioned = first_token.split("@", 1)
    if command != "/connect":
        return False
    if not _telegram_bot_username:
        return False
    return mentioned.lower() == _telegram_bot_username


async def _is_group_admin_via_telegram(chat_id: int | str, user_id: int | str) -> bool:
    """Ask Telegram whether the calling user is an admin/creator in the group."""
    try:
        member = await _telegram_api_call(
            "getChatMember",
            {"chat_id": str(chat_id), "user_id": int(user_id)},
        )
        return member.get("status") in {"administrator", "creator"}
    except Exception as exc:
        logger.warning("Could not verify group admin status for %s in %s: %s", user_id, chat_id, exc)
        return False


async def _request_connect_session_for_group(chat: dict, sender: dict) -> dict:
    """Ask the Node app to mint a connect session for the leads bot command."""
    if not LEADS_INTERNAL_SHARED_SECRET:
        raise RuntimeError("LEADS_INTERNAL_SHARED_SECRET is not configured")

    url = f"{LOCAL_API_BASE_URL.rstrip('/')}/api/internal/facebook/connect-command"
    payload = {
        "telegramGroupId": chat.get("id"),
        "groupName": chat.get("title") or "Unknown",
        "requestedBy": {
            "id": sender.get("id"),
            "name": " ".join(
                part for part in [sender.get("first_name"), sender.get("last_name")] if part
            ) or sender.get("username") or "Unknown",
        },
    }
    headers = {"x-internal-shared-secret": LEADS_INTERNAL_SHARED_SECRET}
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, json=payload, headers=headers)
        data = resp.json()
        if not resp.is_success:
            description = data.get("detail") or data.get("error") or resp.text[:300]
            raise RuntimeError(description)
        return data


def _build_connect_command_reply(connect_result: dict) -> tuple[str, dict]:
    """Format the message and inline button shown by the leads bot."""
    existing_pages = connect_result.get("existingPages", [])
    existing_summary = ""
    if existing_pages:
        names = "\n".join(f"- {page['pageName']}" for page in existing_pages)
        existing_summary = f"\n\nCurrently connected pages:\n{names}"

    text = (
        "Open the button below, sign in to Facebook, and choose which Pages should send leads "
        f"into this group. This link expires in 30 minutes.{existing_summary}"
    )
    reply_markup = {
        "inline_keyboard": [
            [{"text": "Connect Facebook", "url": connect_result["connectUrl"]}]
        ]
    }
    return text, reply_markup


async def _handle_connect_command_message(message: dict):
    """Process one incoming Telegram message for the leads bot token."""
    chat = message.get("chat") or {}
    sender = message.get("from") or {}
    chat_type = chat.get("type")
    if chat_type not in {"group", "supergroup"}:
        await _send_telegram_to_chat(
            chat.get("id"),
            "Run /connect inside the Telegram group that should receive Facebook leads, "
            "not in a private chat with this bot.",
        )
        return

    text = message.get("text") or ""
    if not _extract_connect_command(text):
        return

    chat_id = chat.get("id")
    user_id = sender.get("id")
    if not await _is_group_admin_via_telegram(chat_id, user_id):
        await _send_telegram_to_chat(
            chat_id,
            "Only a group admin can start the Facebook connect flow here.",
        )
        return

    try:
        connect_result = await _request_connect_session_for_group(chat, sender)
    except Exception as exc:
        await _send_telegram_to_chat(
            chat_id,
            f"Could not start Facebook connect right now: {exc}",
        )
        return

    text, reply_markup = _build_connect_command_reply(connect_result)
    await _send_telegram_to_chat(chat_id, text, reply_markup=reply_markup)


async def _request_register_sms_mirror(
    *,
    telegram_chat_id: int | str,
    telegram_message_id: int,
    driver_phone: str,
    sms_body: str,
    source_type: str = "inbound_rc",
) -> dict:
    """Register a Telegram message as replyable via RingCentral SMS."""
    if not LEADS_INTERNAL_SHARED_SECRET:
        raise RuntimeError("LEADS_INTERNAL_SHARED_SECRET is not configured")

    url = f"{LOCAL_API_BASE_URL.rstrip('/')}/api/internal/facebook/register-sms-mirror"
    payload = {
        "telegramChatId": telegram_chat_id,
        "telegramMessageId": telegram_message_id,
        "driverPhone": driver_phone,
        "smsBody": sms_body,
        "sourceType": source_type,
    }
    headers = {"x-internal-shared-secret": LEADS_INTERNAL_SHARED_SECRET}
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, json=payload, headers=headers)
        data = resp.json() if resp.content else {}
        if not resp.is_success:
            description = data.get("error") or data.get("detail") or resp.text[:300]
            raise RuntimeError(description)
        return data


async def _register_inbound_sms_mirror(
    phone: str,
    sms_body: str,
    telegram_message_id: int | None,
) -> None:
    """Link an inbound RC forward Telegram message to the driver phone for replies."""
    if not telegram_message_id:
        return
    normalized_phone = str(phone or "").strip()
    if not normalized_phone or normalized_phone.lower() == "unknown":
        return
    body = str(sms_body or "").strip()
    if not body:
        body = "(no text)"
    try:
        await _request_register_sms_mirror(
            telegram_chat_id=TELEGRAM_CHAT_ID,
            telegram_message_id=telegram_message_id,
            driver_phone=normalized_phone,
            sms_body=body,
            source_type="inbound_rc",
        )
    except Exception as exc:
        logger.warning(
            "Could not register inbound SMS mirror (msg %s, %s): %s",
            telegram_message_id,
            normalized_phone,
            exc,
        )


async def _request_telegram_sms_reply(
    *,
    telegram_chat_id: int | str,
    reply_to_message_id: int,
    reply_text: str,
    user_reply_message_id: int | None = None,
) -> dict:
    """Ask Node to send a RingCentral SMS for a reply to an auto-SMS mirror."""
    if not LEADS_INTERNAL_SHARED_SECRET:
        raise RuntimeError("LEADS_INTERNAL_SHARED_SECRET is not configured")

    url = f"{LOCAL_API_BASE_URL.rstrip('/')}/api/internal/facebook/telegram-sms-reply"
    payload = {
        "telegramChatId": telegram_chat_id,
        "replyToMessageId": reply_to_message_id,
        "replyText": reply_text,
    }
    if user_reply_message_id is not None:
        payload["userReplyMessageId"] = user_reply_message_id

    headers = {"x-internal-shared-secret": LEADS_INTERNAL_SHARED_SECRET}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json=payload, headers=headers)
        data = resp.json() if resp.content else {}
        if not resp.is_success:
            description = data.get("error") or data.get("detail") or resp.text[:300]
            err = RuntimeError(description)
            err.status_code = resp.status_code  # type: ignore[attr-defined]
            raise err
        return data


async def _handle_leads_hub_reply(message: dict) -> None:
    """Forward a Telegram reply to a tracked SMS mirror as RingCentral SMS."""
    chat = message.get("chat") or {}
    chat_type = chat.get("type")
    if chat_type not in {"group", "supergroup"}:
        return

    chat_id = chat.get("id")
    sender = message.get("from") or {}
    if sender.get("is_bot"):
        return

    reply_to = message.get("reply_to_message")
    if not reply_to:
        return

    reply_text = (message.get("text") or message.get("caption") or "").strip()
    if not reply_text:
        return

    mirror_message_id = reply_to.get("message_id")
    user_reply_message_id = message.get("message_id")
    if not mirror_message_id:
        return

    try:
        await _request_telegram_sms_reply(
            telegram_chat_id=chat_id,
            reply_to_message_id=mirror_message_id,
            reply_text=reply_text,
            user_reply_message_id=user_reply_message_id,
        )
        logger.info(
            "Telegram reply in leads hub forwarded via SMS (mirror msg %s).",
            mirror_message_id,
        )
    except Exception as exc:
        status = getattr(exc, "status_code", None)
        if status == 404:
            err_text = (
                "Not linked to a tracked SMS — reply to an auto-SMS copy "
                "or an incoming driver message."
            )
        elif status == 400:
            err_text = str(exc)
        else:
            err_text = f"Could not send SMS: {exc}"
        await _send_telegram_to_chat(
            chat_id,
            err_text,
            reply_to_message_id=user_reply_message_id,
        )
        logger.warning("Leads hub SMS reply failed: %s", exc)


async def _poll_connect_commands():
    """Long-poll Telegram for /connect commands on the leads bot token."""
    global _telegram_update_offset
    await _delete_leads_bot_webhook()
    await _load_telegram_bot_profile()
    await _bootstrap_connect_command_offset()

    while not _connect_command_stop.is_set():
        payload = {
            "timeout": CONNECT_COMMAND_POLL_TIMEOUT,
            "allowed_updates": CONNECT_COMMAND_ALLOWED_UPDATES,
        }
        if _telegram_update_offset is not None:
            payload["offset"] = _telegram_update_offset

        try:
            updates = await asyncio.wait_for(
                _telegram_api_call("getUpdates", payload),
                timeout=CONNECT_COMMAND_POLL_TIMEOUT + 30.0
            )
        except Exception as exc:
            detail = str(exc).strip() or repr(exc)
            logger.warning("Leads bot getUpdates failed: %s", detail)
            await asyncio.sleep(5)
            continue

        for update in updates:
            _telegram_update_offset = update["update_id"] + 1
            message = update.get("message")
            if message:
                await _handle_leads_hub_reply(message)
                await _handle_connect_command_message(message)


async def _send_telegram(text: str) -> int | None:
    """Send a message to Telegram via Bot API.
    
    Retries once on failure. If Markdown parse fails, retries without
    parse_mode so the message is always delivered.
    Returns the message_id on success, None on failure.
    """
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "Markdown",
    }

    for attempt in range(2):  # Try up to 2 times
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(url, json=payload)
                if not resp.is_success:
                    logger.warning("Telegram Markdown send failed (attempt %d), retrying without parse_mode: %s", attempt + 1, resp.text)
                    payload.pop("parse_mode", None)
                    resp2 = await client.post(url, json=payload)
                    if not resp2.is_success:
                        if attempt == 0:
                            logger.warning("Telegram send failed (attempt 1), retrying in 2s...")
                            await asyncio.sleep(2)
                            payload["parse_mode"] = "Markdown"  # Reset for retry
                            continue
                        logger.error("Telegram send failed completely: %s", resp2.text)
                        return None
                    else:
                        logger.info("Telegram message sent (plain text fallback).")
                        return resp2.json().get("result", {}).get("message_id")
                else:
                    logger.info("Telegram message sent successfully.")
                    return resp.json().get("result", {}).get("message_id")
        except Exception as exc:
            if attempt == 0:
                logger.warning("Telegram send exception (attempt 1): %s, retrying in 2s...", exc)
                await asyncio.sleep(2)
                continue
            logger.error("Telegram send failed after retry: %s", exc)
            return None

    return None


async def _send_telegram_html(text: str) -> int | None:
    """Like _send_telegram but parse_mode HTML (for RingCentral forwards with <pre> monospace)."""
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
    }

    for attempt in range(2):
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(url, json=payload)
                if not resp.is_success:
                    logger.warning(
                        "Telegram HTML send failed (attempt %d), retrying without parse_mode: %s",
                        attempt + 1,
                        resp.text,
                    )
                    payload.pop("parse_mode", None)
                    resp2 = await client.post(url, json=payload)
                    if not resp2.is_success:
                        if attempt == 0:
                            logger.warning("Telegram send failed (attempt 1), retrying in 2s...")
                            await asyncio.sleep(2)
                            payload["parse_mode"] = "HTML"
                            continue
                        logger.error("Telegram send failed completely: %s", resp2.text)
                        return None
                    logger.info("Telegram message sent (plain text fallback).")
                    return resp2.json().get("result", {}).get("message_id")
                logger.info("Telegram HTML message sent successfully.")
                return resp.json().get("result", {}).get("message_id")
        except Exception as exc:
            if attempt == 0:
                logger.warning("Telegram send exception (attempt 1): %s, retrying in 2s...", exc)
                await asyncio.sleep(2)
                continue
            logger.error("Telegram send failed after retry: %s", exc)
            return None

    return None


async def _edit_telegram(message_id: int, new_text: str) -> None:
    """Edit an existing Telegram message (to append SMS status).
    
    Silently fails if edit doesn't work — the original message is still there.
    """
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/editMessageText"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "message_id": message_id,
        "text": new_text,
        "parse_mode": "Markdown",
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(url, json=payload)
            if not resp.is_success:
                payload.pop("parse_mode", None)
                resp2 = await client.post(url, json=payload)
                if resp2.is_success:
                    logger.info("Telegram message edited (plain text).")
                else:
                    logger.warning("Telegram edit failed: %s", resp2.text)
            else:
                logger.info("Telegram message edited with SMS status.")
    except Exception as exc:
        logger.warning("Telegram edit error (non-critical): %s", exc)


# ── RingCentral MMS → Telegram (download attachment URIs, sendPhoto / sendMediaGroup) ──

RC_INBOUND_TYPES = frozenset({"SMS", "MMS"})

def _format_ringcentral_forward_html(
    from_number: str,
    subject: str,
    created: str,
    *,
    warning_plain: str | None = None,
    max_body_len: int = 3500,
) -> str:
    """Build Telegram HTML: SMS body in <pre> (monospace), labels in bold/code."""
    body = subject if subject is not None else ""
    if len(body) > max_body_len:
        body = body[: max_body_len - 1] + "…"

    esc_from = html.escape(from_number)
    esc_body = html.escape(body)
    parts = [
        "\U0001f4e9 <b>SMS/MMS Reply Received!</b>",
        "",
        f"\U0001f4de From: <code>{esc_from}</code>",
        "\U0001f4ac Message:",
        f"<pre>{esc_body}</pre>",
    ]
    if created:
        parts.append(f"\U0001f550 Received: <code>{html.escape(created)}</code>")
    if warning_plain:
        parts.append("")
        parts.append(f"<i>{html.escape(warning_plain)}</i>")
    return "\n".join(parts)


def _fit_ringcentral_caption_html(
    from_number: str,
    subject: str,
    created: str,
    *,
    warning_plain: str | None = None,
) -> str:
    """Shrink SMS body in <pre> until full HTML fits Telegram's 1024-char caption limit."""
    limits = list(range(min(len(subject), 850), -1, -25))
    if not limits:
        limits = [0]
    for lim in limits:
        text = _format_ringcentral_forward_html(
            from_number,
            subject,
            created,
            warning_plain=warning_plain,
            max_body_len=max(lim, 0),
        )
        if len(text) <= 1024:
            return text
    return _format_ringcentral_forward_html(
        from_number,
        subject[:50],
        created,
        warning_plain=warning_plain,
        max_body_len=50,
    )


def _ringcentral_media_attachments(event_body: dict) -> list[dict]:
    """Attachment dicts that reference downloadable media (not plain Text duplicates)."""
    out: list[dict] = []
    for att in event_body.get("attachments") or []:
        if not isinstance(att, dict):
            continue
        uri = (att.get("uri") or att.get("contentUri") or "").strip()
        if not uri:
            continue
        atype = (att.get("type") or "").lower()
        ct = (att.get("contentType") or "").lower()
        if atype == "text" and ("text/plain" in ct or ct.startswith("text/")):
            continue
        if ct.startswith("image/") or ct.startswith("video/"):
            out.append(att)
            continue
        if atype in ("mmsattachment", "mms", "file", "attachment"):
            out.append(att)
    return out


def _telegram_upload_method(content_type: str) -> tuple[str, str]:
    """Return (Telegram API method, multipart field name) for this MIME type."""
    ct = (content_type or "").split(";")[0].strip().lower()
    if ct in ("image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"):
        return "sendPhoto", "photo"
    if ct.startswith("video/"):
        return "sendVideo", "video"
    if ct.startswith("image/"):
        return "sendDocument", "document"
    return "sendDocument", "document"


def _attachment_download_filename(att: dict, content_type: str, index: int) -> str:
    raw = (att.get("fileName") or att.get("filename") or "").strip()
    if raw:
        return raw
    ext = mimetypes.guess_extension(content_type.split(";")[0].strip()) or ".bin"
    return f"attachment_{index}{ext}"


async def _send_telegram_upload(
    method: str,
    field: str,
    file_bytes: bytes,
    filename: str,
    mime: str,
    caption: str,
) -> int | None:
    """Multipart upload to Telegram Bot API (photo, video, or document)."""
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/{method}"
    base_data = {"chat_id": TELEGRAM_CHAT_ID, "caption": caption[:1024]}

    for use_html in (True, False):
        data = {**base_data}
        if use_html:
            data["parse_mode"] = "HTML"
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                files = {field: (filename, file_bytes, mime)}
                resp = await client.post(url, data=data, files=files)
            if resp.is_success:
                logger.info("Telegram %s sent successfully.", method)
                payload = resp.json()
                return payload.get("result", {}).get("message_id")
            err = (resp.text or "").lower()
            if use_html and ("parse" in err or "html" in err or "entities" in err):
                logger.warning("Telegram %s caption parse failed, retrying plain: %s", method, resp.text[:200])
                continue
            logger.warning("Telegram %s failed (%s): %s", method, resp.status_code, resp.text[:400])
            return None
        except Exception as exc:
            logger.error("Telegram %s exception: %s", method, exc)
            return None
    return None


async def _send_telegram_media_group_photos(
    caption: str,
    photo_items: list[tuple[bytes, str, str]],
) -> int | None:
    """Send 2–10 images as one album (InputMediaPhoto). All items must be photo-compatible."""
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMediaGroup"
    media_json: list[dict] = []
    files = {}
    for i, (b, fn, mime) in enumerate(photo_items):
        key = f"f{i}"
        media_json.append({"type": "photo", "media": f"attach://{key}"})
        files[key] = (fn, b, mime)
    media_json[0]["caption"] = caption[:1024]

    for use_html in (True, False):
        payload_media = json.loads(json.dumps(media_json))
        if use_html:
            payload_media[0]["parse_mode"] = "HTML"
        else:
            payload_media[0].pop("parse_mode", None)
        try:
            async with httpx.AsyncClient(timeout=120) as client:
                data = {"chat_id": TELEGRAM_CHAT_ID, "media": json.dumps(payload_media)}
                resp = await client.post(url, data=data, files=files)
            if resp.is_success:
                logger.info("Telegram sendMediaGroup sent successfully (%d photos).", len(photo_items))
                result = resp.json().get("result") or []
                if result and isinstance(result, list):
                    return result[0].get("message_id")
                return None
            err = (resp.text or "").lower()
            if use_html and ("parse" in err or "html" in err):
                logger.warning("Telegram sendMediaGroup caption parse failed, retrying plain.")
                continue
            logger.warning("Telegram sendMediaGroup failed: %s", resp.text[:400])
            return None
        except Exception as exc:
            logger.error("Telegram sendMediaGroup exception: %s", exc)
            return None
    return None


async def _forward_ringcentral_inbound_to_telegram(event_body: dict) -> None:
    """Forward inbound SMS/MMS to Telegram: text via sendMessage; images/video via upload."""
    from_number = event_body.get("from", {}).get("phoneNumber", "Unknown")
    subject = event_body.get("subject", "(no text)")
    created = event_body.get("creationTime", "")

    media_atts = _ringcentral_media_attachments(event_body)
    if not media_atts:
        caption_html = _format_ringcentral_forward_html(from_number, subject, created)
        message_id = await _send_telegram_html(caption_html)
        await _register_inbound_sms_mirror(from_number, subject, message_id)
        logger.info("SMS reply from %s forwarded to Telegram (text only).", from_number)
        return

    caption_html = _fit_ringcentral_caption_html(from_number, subject, created)

    downloaded: list[tuple[bytes, str, str]] = []
    for i, att in enumerate(media_atts):
        uri = (att.get("uri") or att.get("contentUri") or "").strip()
        try:
            raw, ct = await download_ringcentral_attachment(uri)
            fn = _attachment_download_filename(att, ct, i)
            downloaded.append((raw, fn, ct))
            logger.info(
                "Downloaded RC attachment %d bytes, type %s",
                len(raw),
                ct,
            )
        except Exception as exc:
            logger.error("RingCentral attachment download failed (%s): %s", uri[:120], exc)

    if not downloaded:
        warn_html = _format_ringcentral_forward_html(
            from_number,
            subject,
            created,
            warning_plain="Could not download MMS attachments — check RingCentral credentials.",
        )
        message_id = await _send_telegram_html(warn_html)
        await _register_inbound_sms_mirror(from_number, subject, message_id)
        return

    photo_compatible: list[tuple[bytes, str, str]] = []
    other_items: list[tuple[bytes, str, str]] = []
    for item in downloaded:
        method, _ = _telegram_upload_method(item[2])
        if method == "sendPhoto":
            photo_compatible.append(item)
        else:
            other_items.append(item)

    if len(photo_compatible) >= 2 and len(photo_compatible) <= 10 and not other_items:
        album_message_id = await _send_telegram_media_group_photos(caption_html, photo_compatible)
        if album_message_id:
            await _register_inbound_sms_mirror(from_number, subject, album_message_id)
            logger.info("MMS from %s forwarded to Telegram as album (%d).", from_number, len(photo_compatible))
            return
        logger.warning("sendMediaGroup failed; falling back to individual sends.")

    first_message_id = None
    for idx, (b, fn, ct) in enumerate(downloaded):
        cap = caption_html if idx == 0 else ""
        method, field = _telegram_upload_method(ct)
        uploaded_id = await _send_telegram_upload(method, field, b, fn, ct, cap)
        if idx == 0 and uploaded_id:
            first_message_id = uploaded_id
    await _register_inbound_sms_mirror(from_number, subject, first_message_id)
    logger.info("MMS from %s forwarded to Telegram (%d file(s)).", from_number, len(downloaded))


# ── Startup: register RingCentral webhook ────────────────────
@app.on_event("startup")
async def _startup_register_rc_webhook():
    """Register background tasks for the leads bot service."""
    async def _delayed_register():
        await asyncio.sleep(3)
        callback = f"{BASE_URL}/rc-webhook"
        logger.info("Registering RingCentral SMS webhook → %s", callback)
        await register_sms_webhook(callback)

    asyncio.create_task(_delayed_register())
    global _connect_command_task
    _connect_command_stop.clear()
    _connect_command_task = asyncio.create_task(_poll_connect_commands())


@app.on_event("shutdown")
async def _shutdown_connect_command_poller():
    """Stop the leads bot Telegram long-poll loop cleanly."""
    _connect_command_stop.set()
    global _connect_command_task
    if _connect_command_task:
        _connect_command_task.cancel()
        try:
            await _connect_command_task
        except asyncio.CancelledError:
            pass
        _connect_command_task = None


@app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
async def root_probe():
    """Render/port scanners often hit `/` with HEAD; return 200 without requiring a path prefix."""
    return Response(status_code=200)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/rc-webhook")
async def rc_webhook(request: Request):
    """Receive RingCentral webhook events (incoming SMS replies)."""
    # ── Validation handshake ──
    validation_token = request.headers.get("Validation-Token", "")
    if validation_token:
        logger.info("RingCentral webhook validation received — echoing token.")
        return Response(
            status_code=200,
            headers={"Validation-Token": validation_token},
        )

    # ── Process incoming event ──
    try:
        body = await request.json()
        logger.info("RingCentral webhook event: %s", json.dumps(body, indent=2)[:500])

        event_body = body.get("body", {})

        direction = event_body.get("direction", "")
        msg_type = event_body.get("type", "")
        if direction != "Inbound" or msg_type not in RC_INBOUND_TYPES:
            logger.info(
                "RC webhook: ignoring event (direction=%s, type=%s).",
                direction,
                msg_type,
            )
            return {"status": "ignored"}

        await _forward_ringcentral_inbound_to_telegram(event_body)

    except Exception as exc:
        logger.error("Error processing RingCentral webhook: %s", exc)

    return {"status": "ok"}


@app.get("/webhook")
async def verify_webhook(request: Request):
    """Facebook webhook verification (GET)."""
    params = request.query_params
    mode = params.get("hub.mode")
    token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge")

    if mode == "subscribe" and token == WEBHOOK_VERIFY_TOKEN:
        logger.info("Webhook verified successfully.")
        return PlainTextResponse(challenge)

    logger.warning("Webhook verification failed. token=%s", token)
    raise HTTPException(status_code=403, detail="Verification failed")


@app.post("/webhook")
async def receive_webhook(request: Request):
    """Facebook webhook: handles both leadgen and Messenger events.
    
    CRITICAL: Returns 200 immediately and processes leads in the background.
    This prevents Facebook from timing out when many leads arrive at once.
    """
    body = await request.body()

    # Verify signature. The previous implementation treated a missing
    # META_APP_SECRET as "skip verification", which meant a misconfigured
    # deploy silently accepted unsigned webhook traffic from anyone. Fail
    # closed instead: no secret configured → reject every webhook.
    if not META_APP_SECRET:
        logger.error("META_APP_SECRET not configured — rejecting webhook (fail closed).")
        raise HTTPException(status_code=500, detail="Webhook secret not configured")

    sig = request.headers.get("X-Hub-Signature-256", "")
    if not _verify_signature(body, sig):
        logger.warning("Invalid signature — rejecting webhook.")
        raise HTTPException(status_code=403, detail="Invalid signature")

    try:
        data = json.loads(body)
        logger.info("Webhook received raw payload: %s", data)
    except json.JSONDecodeError:
        logger.error("Failed to decode JSON body: %s", body)
        raise HTTPException(status_code=400, detail="Bad JSON")

    if data.get("object") != "page":
        return {"status": "ignored"}

    result = await _forward_verified_facebook_payload(data)
    logger.info("Forwarded verified Facebook payload to Node app: %s", result)
    return {"status": "ok", **result}


# ── Legacy in-process Facebook lead handling (pre-Node queue) ──
# Live Meta webhooks are forwarded to Node above. The functions below remain only
# for the internal GET /retry/{leadgen_id} helper on the leads-bot port.


async def _process_leads_batch(leadgen_ids: list[str]) -> None:
    """Process a batch of leads in the background with error isolation and staggering."""
    for i, leadgen_id in enumerate(leadgen_ids):
        try:
            # Log the lead as received
            _log_lead(leadgen_id, "processing")

            await _process_lead(leadgen_id)

            # Update log to success
            _log_lead(leadgen_id, "sent_ok")
        except Exception as exc:
            logger.error("Unexpected error processing lead %s: %s", leadgen_id, exc)
            _log_lead(leadgen_id, "error", str(exc))

        # Stagger between leads to avoid Telegram rate limits (30 msgs/sec)
        if i < len(leadgen_ids) - 1:
            await asyncio.sleep(0.5)


async def _process_messenger_batch(events: list[dict]) -> None:
    """Process a batch of messenger events in the background with error isolation."""
    for i, event in enumerate(events):
        sender_id = event.get("sender", {}).get("id", "unknown")
        try:
            _log_lead(f"msg_{sender_id}", "processing", "messenger_event")
            await _process_messenger_event(event)
            _log_lead(f"msg_{sender_id}", "sent_ok", "messenger_event")
        except Exception as exc:
            logger.error("Unexpected error processing messenger event: %s", exc)
            _log_lead(f"msg_{sender_id}", "error", str(exc))

        if i < len(events) - 1:
            await asyncio.sleep(0.5)


@app.get("/retry/{leadgen_id}")
async def retry_lead(leadgen_id: str):
    """Manually retry fetching and sending a lead that previously failed."""
    logger.info("Manual retry requested for lead ID: %s", leadgen_id)
    _log_lead(leadgen_id, "retry_requested")
    result = await _process_lead(leadgen_id)
    _log_lead(leadgen_id, result)
    return {"status": "ok", "lead_id": leadgen_id, "result": result}


@app.get("/leads-log")
async def get_leads_log():
    """Return the leads log for debugging/auditing."""
    try:
        if LEADS_LOG_FILE.exists():
            entries = json.loads(LEADS_LOG_FILE.read_text())
            return {"count": len(entries), "entries": entries[-50:]}  # Last 50
        return {"count": 0, "entries": []}
    except Exception as exc:
        return {"error": str(exc)}


async def _process_lead(leadgen_id: str) -> str:
    """Re-queue lead processing on the Node worker (admin-managed SMS templates)."""
    logger.info("Queueing lead retry via Node for lead ID: %s", leadgen_id)

    try:
        result = await _forward_retry_leadgen_to_node(leadgen_id)
        if result.get("status") == "not_found":
            logger.warning("No webhook event found for leadgen id %s", leadgen_id)
            return "no_webhook_event_found"
        logger.info("Lead %s queued on Node worker", leadgen_id)
        return "queued_node_retry"
    except Exception as exc:
        logger.error("Node retry forward failed for lead %s: %s", leadgen_id, exc)
        return f"node_retry_error: {exc}"


async def _process_messenger_event(event: dict) -> None:
    """Handle a single Messenger messaging event.
    
    Only notifies Telegram on the FIRST message from each new sender.
    Ignores echoes (messages sent BY the page), delivery receipts, and reads.
    """
    try:
        # Ignore echoes (messages sent by the page itself)
        message = event.get("message", {})
        if message.get("is_echo"):
            return

        # Ignore delivery/read receipts
        if "delivery" in event or "read" in event:
            return

        sender_id = event.get("sender", {}).get("id", "")
        if not sender_id:
            return

        # Only notify on FIRST message from this sender
        if not _is_new_sender(sender_id):
            logger.info("Messenger: returning sender %s, skipping notification.", sender_id)
            return

        logger.info("Messenger: NEW sender %s — sending Telegram notification.", sender_id)

        # Get message text
        message_text = message.get("text", "")

        # Attachments (images, files, etc.)
        attachments = message.get("attachments", [])
        if attachments and not message_text:
            attachment_types = [a.get("type", "unknown") for a in attachments]
            message_text = f"[Attachment: {', '.join(attachment_types)}]"
        elif attachments and message_text:
            attachment_types = [a.get("type", "unknown") for a in attachments]
            message_text += f"\n[+ Attachment: {', '.join(attachment_types)}]"

        # Fetch sender's profile
        profile = await fetch_sender_profile(sender_id)

        # Format and send
        telegram_msg = format_messenger_message(profile, message_text, sender_id)
        await _send_telegram(telegram_msg)

    except Exception as exc:
        logger.error("Error processing Messenger event: %s", exc)
        # Still try to notify with whatever we have
        sender_id = event.get("sender", {}).get("id", "unknown")
        fallback = (
            f"💬 *New Messenger Contact!*\n\n"
            f"🆔 Sender ID: `{sender_id}`\n"
            f"⚠️ Could not process message details.\n"
            f"Error: `{exc}`"
        )
        await _send_telegram(fallback)
