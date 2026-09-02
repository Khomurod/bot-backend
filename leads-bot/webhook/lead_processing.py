"""
The two single-item processors the /retry route and Messenger handling use.

LEAD RETRY IS A RE-QUEUE, NOT A RE-SEND. _process_lead hands the id back to the
Node worker, which owns the dedupe ledger and the admin-managed SMS templates —
so pressing retry twice cannot deliver a lead twice, and a retry always uses
the CURRENT templates rather than whatever this service was deployed with.

Messenger notifications fire only on a sender's FIRST message (see
state._is_new_sender). Echoes of the page's own messages, delivery receipts and
read receipts are ignored, because a recruiter needs to know a new person made
contact, not that their own reply was delivered.

The handler's own except branch still notifies, with the sender id and the
error. A Messenger contact that cannot be parsed is worth strictly more than
silence — someone is waiting for a reply.

Split out of leads-bot/webhook_server.py.
"""
import logging

from graph import fetch_sender_profile, format_messenger_message

from .hub_client import _forward_retry_leadgen_to_node
from .state import _is_new_sender
from .telegram_client import _send_telegram

logger = logging.getLogger(__name__)


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
