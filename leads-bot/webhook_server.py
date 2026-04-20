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
import json
import logging
import os
import time
from collections import OrderedDict
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse, Response

from config import META_APP_SECRET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, WEBHOOK_VERIFY_TOKEN
from graph import fetch_lead, format_lead_message, fetch_sender_profile, format_messenger_message
from sms import send_sms, register_sms_webhook

import httpx

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Leads Webhook")

# ── Data directory for persistent files ──────────────────────
DATA_DIR = Path(__file__).parent / "data"
DATA_DIR.mkdir(exist_ok=True)

LEADS_LOG_FILE = DATA_DIR / "leads_log.json"
SEEN_SENDERS_FILE = DATA_DIR / "seen_senders.json"

# ── Public base URL (for RingCentral webhook callback) ────────
BASE_URL = os.environ.get("RENDER_EXTERNAL_URL", "https://leads-bot-e6x5.onrender.com")

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


# ── Startup: register RingCentral webhook ────────────────────
@app.on_event("startup")
async def _startup_register_rc_webhook():
    """Register RingCentral webhook subscription after a short delay."""
    async def _delayed_register():
        await asyncio.sleep(3)
        callback = f"{BASE_URL}/rc-webhook"
        logger.info("Registering RingCentral SMS webhook → %s", callback)
        await register_sms_webhook(callback)

    asyncio.create_task(_delayed_register())


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
        if direction != "Inbound" or msg_type != "SMS":
            logger.info("RC webhook: ignoring non-inbound-SMS event (direction=%s, type=%s).", direction, msg_type)
            return {"status": "ignored"}

        from_number = event_body.get("from", {}).get("phoneNumber", "Unknown")
        to_number = event_body.get("to", [{}])[0].get("phoneNumber", "Unknown") if event_body.get("to") else "Unknown"
        subject = event_body.get("subject", "(no text)")
        created = event_body.get("creationTime", "")

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

    # ── Collect all work items, then process in background ──
    leadgen_ids = []
    messenger_events = []

    for entry in data.get("entry", []):
        # Collect leadgen IDs
        for change in entry.get("changes", []):
            if change.get("field") != "leadgen":
                continue
            value = change.get("value", {})
            leadgen_id = value.get("leadgen_id")
            if leadgen_id:
                leadgen_ids.append(leadgen_id)

        # Collect messenger events
        for messaging_event in entry.get("messaging", []):
            messenger_events.append(messaging_event)

    # ── Fire background tasks and return 200 immediately ──
    if leadgen_ids:
        logger.info("Queuing %d lead(s) for background processing: %s", len(leadgen_ids), leadgen_ids)
        asyncio.create_task(_process_leads_batch(leadgen_ids))

    if messenger_events:
        logger.info("Queuing %d messenger event(s) for background processing.", len(messenger_events))
        asyncio.create_task(_process_messenger_batch(messenger_events))

    # Return 200 immediately — Facebook gets a fast response
    return {"status": "ok"}


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
