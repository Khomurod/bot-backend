"""
FastAPI webhook server.
- GET  /webhook          → Facebook verification challenge
- POST /webhook          → Receive lead notifications + Messenger messages
- POST /rc-webhook       → RingCentral incoming SMS notifications
- GET  /health           → Render health check
- GET  /retry/{lead_id}  → Re-fetch and resend a failed lead
"""
import hashlib
import hmac
import json
import logging
import os
from collections import OrderedDict

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse, Response

from config import META_APP_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, WEBHOOK_VERIFY_TOKEN
from graph import fetch_lead, format_lead_message, fetch_sender_profile, format_messenger_message
from sms import send_sms, register_sms_webhook

import httpx

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Leads Webhook")

# ── Public base URL (for RingCentral webhook callback) ────────
BASE_URL = os.environ.get("RENDER_EXTERNAL_URL", "https://leads-bot-e6x5.onrender.com")

# ── De-duplication: track seen Messenger senders ──────────────────
# Only notify on the FIRST message from each new sender.
# Uses an OrderedDict as an LRU cache (max 5000 entries) so memory stays bounded.
MAX_SEEN = 5000
_seen_senders: OrderedDict[str, bool] = OrderedDict()


def _is_new_sender(sender_id: str) -> bool:
    """Return True if this sender hasn't messaged before (first contact)."""
    if sender_id in _seen_senders:
        # Move to end (most recent)
        _seen_senders.move_to_end(sender_id)
        return False
    # New sender — track them
    _seen_senders[sender_id] = True
    # Evict oldest if over limit
    while len(_seen_senders) > MAX_SEEN:
        _seen_senders.popitem(last=False)
    return True


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


async def _send_telegram(text: str) -> int | None:
    """Send a message to Telegram via Bot API.
    
    If Markdown parse fails, retries without parse_mode so the message
    is always delivered even if formatting chars cause issues.
    Returns the message_id on success, None on failure.
    """
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "Markdown",
    }
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, json=payload)
        if not resp.is_success:
            logger.warning("Telegram Markdown send failed, retrying without parse_mode: %s", resp.text)
            payload.pop("parse_mode", None)
            resp2 = await client.post(url, json=payload)
            if not resp2.is_success:
                logger.error("Telegram send failed completely: %s", resp2.text)
                return None
            else:
                logger.info("Telegram message sent (plain text fallback).")
                return resp2.json().get("result", {}).get("message_id")
        else:
            logger.info("Telegram message sent successfully.")
            return resp.json().get("result", {}).get("message_id")


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
                # Try without Markdown if formatting fails
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


# ── Startup: register RingCentral webhook ────────────────────
@app.on_event("startup")
async def _startup_register_rc_webhook():
    """Register RingCentral webhook subscription after a short delay.

    Runs as a background task with a 3s delay so uvicorn is fully
    listening before RingCentral tries to validate /rc-webhook.
    """
    import asyncio

    async def _delayed_register():
        await asyncio.sleep(3)  # Let uvicorn fully start before RC validates
        callback = f"{BASE_URL}/rc-webhook"
        logger.info("Registering RingCentral SMS webhook → %s", callback)
        await register_sms_webhook(callback)

    asyncio.create_task(_delayed_register())


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/rc-webhook")
async def rc_webhook(request: Request):
    """Receive RingCentral webhook events (incoming SMS replies).

    Handles two scenarios:
    1. Validation handshake — RC sends Validation-Token header, we echo it back.
    2. Incoming SMS event — we forward the reply to Telegram.
    """
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

        # Only process inbound SMS (ignore outbound / delivery status)
        direction = event_body.get("direction", "")
        msg_type = event_body.get("type", "")
        if direction != "Inbound" or msg_type != "SMS":
            logger.info("RC webhook: ignoring non-inbound-SMS event (direction=%s, type=%s).", direction, msg_type)
            return {"status": "ignored"}

        # Extract sender and message
        from_number = event_body.get("from", {}).get("phoneNumber", "Unknown")
        to_number = event_body.get("to", [{}])[0].get("phoneNumber", "Unknown") if event_body.get("to") else "Unknown"
        subject = event_body.get("subject", "(no text)")
        created = event_body.get("creationTime", "")

        # Format and send to Telegram
        telegram_msg = (
            f"\U0001F4E9 *SMS Reply Received!*\n\n"
            f"\U0001F4DE From: `{from_number}`\n"
            f"\U0001F4AC Message: {subject}\n"
        )
        if created:
            telegram_msg += f"\n\U0001F550 Received: {created}"

        await _send_telegram(telegram_msg)
        logger.info("SMS reply from %s forwarded to Telegram.", from_number)

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
    """Facebook webhook: handles both leadgen and Messenger events."""
    body = await request.body()

    # Verify signature
    sig = request.headers.get("X-Hub-Signature-256", "")
    if META_APP_SECRET and not _verify_signature(body, sig):
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

    for entry in data.get("entry", []):
        # ── Handle Lead Ad form submissions (leadgen) ──
        for change in entry.get("changes", []):
            if change.get("field") != "leadgen":
                continue
            value = change.get("value", {})
            leadgen_id = value.get("leadgen_id")
            if not leadgen_id:
                continue
            await _process_lead(leadgen_id)

        # ── Handle Messenger messages ──
        for messaging_event in entry.get("messaging", []):
            await _process_messenger_event(messaging_event)

    return {"status": "ok"}


@app.get("/retry/{leadgen_id}")
async def retry_lead(leadgen_id: str):
    """Manually retry fetching and sending a lead that previously failed."""
    logger.info("Manual retry requested for lead ID: %s", leadgen_id)
    result = await _process_lead(leadgen_id)
    return {"status": "ok", "lead_id": leadgen_id, "result": result}


async def _process_lead(leadgen_id: str) -> str:
    """Fetch lead data from Graph API, send to Telegram, and auto-SMS.
    
    Returns a status string. Never raises — always sends SOMETHING to Telegram.
    SMS is a bonus step that never affects the Telegram flow.
    """
    logger.info("Processing lead ID: %s", leadgen_id)

    try:
        lead_data = await fetch_lead(leadgen_id)
        logger.info("Graph API returned lead data for %s", leadgen_id)
    except Exception as exc:
        logger.error("Graph API fetch failed for lead %s: %s", leadgen_id, exc)
        fallback_msg = (
            f"🔔 *FACEBOOK LEAD RECEIVED!*\n\n"
            f"🆔 Lead ID: `{leadgen_id}`\n"
            f"⚠️ Could not fetch details from Graph API.\n"
            f"Error: `{exc}`"
        )
        await _send_telegram(fallback_msg)
        return "sent_fallback_fetch_error"

    try:
        message = format_lead_message(lead_data)
    except Exception as exc:
        logger.error("Format error for lead %s: %s", leadgen_id, exc)
        raw = json.dumps(lead_data, indent=2, ensure_ascii=False)
        message = (
            f"🔔 *FACEBOOK LEAD RECEIVED!*\n\n"
            f"🆔 Lead ID: `{leadgen_id}`\n"
            f"⚠️ Could not format lead data.\n"
            f"Raw data:\n```\n{raw[:3000]}\n```"
        )

    try:
        logger.info("Sending Telegram message for lead %s", leadgen_id)
        msg_id = await _send_telegram(message)
    except Exception as exc:
        logger.error("Telegram send failed for lead %s: %s", leadgen_id, exc)
        return "telegram_error"

    # ── Auto-SMS via RingCentral (never affects Telegram flow) ──
    sms_status = "⏭ Skipped (no phone)"
    try:
        from graph import _safe_field_value
        field_map = {}
        for field in lead_data.get("field_data", []):
            name = field.get("name", "")
            value = _safe_field_value(field)
            if name and value:
                field_map[name] = value

        phone = field_map.get("phone_number") or field_map.get("phone", "")
        full_name = field_map.get("full_name", "Driver")
        first_name = full_name.split()[0] if full_name else "Driver"

        if phone:
            sms_text = (
                f"Hello {first_name}, this is Tom with Wenze trucking company "
                f"and thanks for applying to our OTR position. "
                f"Can I call you right now to explain the details?"
            )
            sent = await send_sms(to=phone, message=sms_text)
            if sent:
                sms_status = f"✅ Sent to {phone}"
                logger.info("SMS sent to %s for lead %s", phone, leadgen_id)
            else:
                sms_status = f"❌ Failed ({phone})"
                logger.info("SMS failed for lead %s (phone: %s)", leadgen_id, phone)
        else:
            logger.info("No phone number for lead %s — SMS skipped.", leadgen_id)
    except Exception as exc:
        sms_status = f"❌ Error: {exc}"
        logger.warning("SMS error for lead %s (non-critical): %s", leadgen_id, exc)

    # ── Edit Telegram message to show SMS result ──
    if msg_id:
        updated_message = message + f"\n\n📱 SMS: {sms_status}"
        await _edit_telegram(msg_id, updated_message)

    return "sent_ok"


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
