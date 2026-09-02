"""
Every Telegram Bot API call this service makes.

WHY ONE MODULE: the bot token is embedded in the URL, so httpx/httpcore INFO
logging is silenced at import in webhook_server and no request URL is ever
logged from here. Keeping the calls together is what makes that guarantee
checkable.

Retry shape, preserved exactly: a send is attempted twice, and a parse_mode
failure retries WITHOUT parse_mode rather than giving up — a lead notification
with broken Markdown still has to reach the hub group. `getUpdates` gets a read
timeout longer than Telegram's own long-poll window, because a 20s read timeout
against a 50s long poll produces a ReadTimeout on every single call.

_is_leads_hub_chat accepts both -100xxx and -xxx forms of the same supergroup:
Telegram reports the same chat under either shape depending on the API surface,
and treating them as different chats is how replies in the hub group stop being
recognised.

Split out of leads-bot/webhook_server.py.
"""
import asyncio
import json
import logging

import httpx

from config import TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

logger = logging.getLogger(__name__)

TELEGRAM_API_BASE = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"


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
