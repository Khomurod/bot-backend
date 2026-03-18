"""
Fetches full lead details from the Meta Graph API using a leadgen_id.
"""
import logging
import httpx
from config import META_PAGE_ACCESS_TOKEN

logger = logging.getLogger(__name__)

GRAPH_BASE = "https://graph.facebook.com/v19.0"


async def fetch_lead(leadgen_id: str) -> dict:
    """Return a dict with the lead's field_data list, or empty dict on failure."""
    url = f"{GRAPH_BASE}/{leadgen_id}"
    params = {
        "access_token": META_PAGE_ACCESS_TOKEN,
        "fields": "field_data,created_time,id",
    }
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        return resp.json()


def _safe_field_value(field: dict) -> str:
    """Safely extract the value from a field_data entry, no matter the format."""
    try:
        values = field.get("values", [])
        if isinstance(values, list) and len(values) > 0:
            return ", ".join(str(v) for v in values)
        elif isinstance(values, str):
            return values
        return ""
    except Exception:
        return ""


def format_lead_message(lead_data: dict) -> str:
    """Turn raw Graph API lead data into a Telegram message string.
    
    This function is designed to NEVER crash — it handles any unexpected
    data format gracefully, so no lead is ever lost.
    """
    try:
        lines = ["🔔 *New Facebook Lead!*\n"]

        # Build field_map safely — skip fields with empty/missing values
        field_map = {}
        for field in lead_data.get("field_data", []):
            try:
                name = field.get("name", "unknown")
                value = _safe_field_value(field)
                if value:  # only include fields that have actual data
                    field_map[name] = value
            except Exception as exc:
                logger.warning("Skipping malformed field %s: %s", field, exc)
                continue

        # Common fields – show them in a friendly order
        pretty_keys = {
            "full_name": "👤 Name",
            "first_name": "👤 First Name",
            "last_name": "Last Name",
            "email": "📧 Email",
            "phone_number": "📞 Phone",
            "phone": "📞 Phone",
            "city": "🏙 City",
            "state": "🗺 State",
            "zip_code": "📮 ZIP",
            "country": "🌍 Country",
            "company_name": "🏢 Company",
            "job_title": "💼 Job Title",
            "message": "💬 Message",
            "comments": "💬 Comments",
            "inbox_url": "📥 Inbox Url",
        }

        shown = set()
        for key, label in pretty_keys.items():
            if key in field_map:
                lines.append(f"{label}: {field_map[key]}")
                shown.add(key)

        # Any extra fields from the form that aren't in our map
        for key, value in field_map.items():
            if key not in shown:
                lines.append(f"• {key.replace('_', ' ').title()}: {value}")

        lead_id = lead_data.get("id", "N/A")
        created = lead_data.get("created_time", "")
        if created:
            lines.append(f"\n🕐 Submitted: {created}")
        lines.append(f"🆔 Lead ID: `{lead_id}`")

        return "\n".join(lines)

    except Exception as exc:
        # Ultimate fallback — dump whatever we have as raw text
        logger.error("format_lead_message crashed: %s", exc)
        lead_id = lead_data.get("id", "unknown")
        raw_fields = ""
        for field in lead_data.get("field_data", []):
            raw_fields += f"\n• {field}"
        return (
            f"🔔 *New Facebook Lead!*\n\n"
            f"🆔 Lead ID: `{lead_id}`\n"
            f"⚠️ Could not format this lead cleanly.\n"
            f"Raw data:{raw_fields}"
        )


async def fetch_sender_profile(sender_id: str) -> dict:
    """Fetch a Messenger sender's profile info (name) from Graph API.
    
    Returns dict with first_name, last_name, or empty dict on failure.
    """
    url = f"{GRAPH_BASE}/{sender_id}"
    params = {
        "access_token": META_PAGE_ACCESS_TOKEN,
        "fields": "first_name,last_name,name,profile_pic",
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(url, params=params)
            if resp.is_success:
                return resp.json()
            else:
                logger.warning("Could not fetch sender profile for %s: %s", sender_id, resp.text)
                return {}
    except Exception as exc:
        logger.warning("Error fetching sender profile %s: %s", sender_id, exc)
        return {}


def format_messenger_message(sender_profile: dict, message_text: str, sender_id: str) -> str:
    """Format a Messenger lead notification for Telegram."""
    first = sender_profile.get("first_name", "")
    last = sender_profile.get("last_name", "")
    name = f"{first} {last}".strip() or sender_profile.get("name", "Unknown")

    lines = [
        "💬 *New Messenger Lead!*\n",
        f"👤 Name: {name}",
        f"🆔 Sender ID: `{sender_id}`",
        f"\n📩 Message:",
        message_text or "(no text)",
        f"\n📥 Inbox: https://business.facebook.com/latest/{sender_id}?navref=threadviewbypsid",
    ]
    return "\n".join(lines)
