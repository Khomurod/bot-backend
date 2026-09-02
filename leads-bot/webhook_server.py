"""
FastAPI webhook server for the Facebook leads engine.
- GET  /webhook          → Facebook verification challenge
- POST /webhook          → Receive lead notifications + Messenger messages
- POST /rc-webhook       → RingCentral incoming SMS notifications
- GET  /health           → Render health check
- GET  /retry/{lead_id}  → Re-fetch and resend a failed lead

APP ASSEMBLY AND ROUTES ONLY. The work each route delegates to lives in
./webhook/ (see webhook/__init__.py for the map). This module is what uvicorn
starts — "webhook_server:app" in main.py — so the import path is unchanged.

The names re-exported below are imported here because the routes use them and
because leads-bot's tests address them through this module; nothing else in the
tree imports webhook_server.
"""
import asyncio
import json
import logging
import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse, Response

from config import META_APP_SECRET, WEBHOOK_VERIFY_TOKEN
from sms import register_sms_webhook

import httpx  # noqa: F401  (tests patch webhook_server.httpx)

from webhook.connect_command import (
    _extract_connect_command,
    start_connect_command_poller,
    stop_connect_command_poller,
)
from webhook.hub_client import _forward_verified_facebook_payload
from webhook.lead_processing import _process_lead
from webhook.meta_signature import _verify_signature
from webhook.ringcentral import (
    RC_INBOUND_TYPES,
    _fit_ringcentral_caption_html,
    _format_ringcentral_forward_html,
    _forward_ringcentral_inbound_to_telegram,
    _ringcentral_media_attachments,
)
from webhook.state import _log_lead, _read_leads_log
from webhook.telegram_client import _telegram_upload_method

logging.basicConfig(level=logging.INFO)
# Avoid logging full Telegram URLs (they embed the bot token) at INFO.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)

app = FastAPI(title="Leads Webhook")

# ── Public base URL (for RingCentral webhook callback) ────────
BASE_URL = os.environ.get("RENDER_EXTERNAL_URL", "https://bot-backend-x9lc.onrender.com")


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
    start_connect_command_poller()


@app.on_event("shutdown")
async def _shutdown_connect_command_poller():
    """Stop the leads bot Telegram long-poll loop cleanly."""
    await stop_connect_command_poller()


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
# Live Meta webhooks are forwarded to Node above. _process_lead
# (./webhook/lead_processing.py) remains only for the internal
# GET /retry/{leadgen_id} helper on the leads-bot port.
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
    entries = _read_leads_log()
    return {"count": len(entries), "entries": entries[-50:]}  # Last 50
