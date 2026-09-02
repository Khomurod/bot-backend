"""
The /connect group flow, and replies typed in the leads hub group.

/CONNECT IS ADMIN-GATED VIA TELEGRAM ITSELF: _is_group_admin_via_telegram asks
Telegram for the caller's status in that group rather than trusting anything in
the message. Connecting a Facebook Page is what routes a company's leads, so
the check has to come from the platform, not from the request.

`/connect@SomeBot` is only ours when the mention matches this bot's username,
which is why the username is fetched at startup. Until it is known, a mentioned
form is REFUSED rather than assumed — answering another bot's command in a
shared group would be worse than not answering.

Replies in the hub group are relayed back out as SMS through the Node hub, and
each inbound SMS registers a mirror so a reply knows which number it belongs
to. A reply with no registered mirror is reported, never guessed at.

This module owns `_telegram_update_offset` and `_telegram_bot_username`; both
are set through the functions here and read nowhere else.

Split out of leads-bot/webhook_server.py.
"""
import asyncio
import logging

import httpx

from config import LEADS_INTERNAL_SHARED_SECRET, LOCAL_API_BASE_URL

from .telegram_client import (
    _delete_leads_bot_webhook,
    _is_leads_hub_chat,
    _send_telegram_to_chat,
    _telegram_api_call,
)

logger = logging.getLogger(__name__)

CONNECT_COMMAND_POLL_TIMEOUT = 50
CONNECT_COMMAND_ALLOWED_UPDATES = ["message"]
_connect_command_task: asyncio.Task | None = None
_connect_command_stop = asyncio.Event()
_telegram_update_offset: int | None = None
_telegram_bot_username: str = ""


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


def start_connect_command_poller() -> None:
    """Start the Telegram long-poll loop for /connect and hub replies."""
    global _connect_command_task
    _connect_command_stop.clear()
    _connect_command_task = asyncio.create_task(_poll_connect_commands())


async def stop_connect_command_poller() -> None:
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
