"""
RingCentral SMS sender.

Sends an auto-response SMS to new leads via the RingCentral REST API.
Uses JWT authentication for a permanent, non-expiring connection.

If RingCentral credentials are not configured, all functions are no-ops.
"""
import logging
import httpx
from config import RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT_TOKEN, RC_FROM_NUMBER

logger = logging.getLogger(__name__)

# Cache the access token so we don't re-auth on every SMS
_cached_token: dict = {"access_token": "", "expires_at": 0}

# Base URL for relative attachment URIs from webhook payloads
RC_PLATFORM_BASE = "https://platform.ringcentral.com"

# Subscriptions must include these filters so inbound SMS and MMS (photos) are delivered.
RC_INBOUND_SMS_MMS_FILTERS: tuple[str, ...] = (
    "/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS",
    "/restapi/v1.0/account/~/extension/~/message-store/instant?type=MMS",
)


def resolve_ringcentral_uri(uri: str) -> str:
    """Make attachment URIs absolute; RingCentral often returns a path under /restapi/..."""
    if not uri or not isinstance(uri, str):
        return ""
    u = uri.strip()
    if u.startswith("http://") or u.startswith("https://"):
        return u
    if u.startswith("/"):
        return RC_PLATFORM_BASE + u
    return RC_PLATFORM_BASE + "/" + u


async def download_ringcentral_attachment(uri: str) -> tuple[bytes, str]:
    """Fetch MMS/SMS attachment bytes using RingCentral OAuth (Bearer).

    Returns (content_bytes, content_type_without_charset).
    Raises on HTTP errors or missing RC credentials.
    """
    if not uri:
        raise ValueError("empty attachment uri")
    if not all([RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT_TOKEN]):
        raise RuntimeError("RingCentral credentials not configured — cannot download MMS attachments.")

    full_uri = resolve_ringcentral_uri(uri)
    token = await _get_access_token()
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(timeout=120) as client:
        resp = await client.get(full_uri, headers=headers, follow_redirects=True)
        resp.raise_for_status()
        ct = (resp.headers.get("content-type") or "application/octet-stream").split(";")[0].strip()
        return resp.content, ct


async def _get_access_token() -> str:
    """Exchange JWT for a short-lived RingCentral access token.
    
    Caches the token and reuses it until close to expiry.
    """
    import time

    # Return cached token if still valid (with 60s buffer)
    if _cached_token["access_token"] and time.time() < _cached_token["expires_at"] - 60:
        return _cached_token["access_token"]

    url = "https://platform.ringcentral.com/restapi/oauth/token"
    data = {
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": RC_JWT_TOKEN,
    }
    auth = (RC_CLIENT_ID, RC_CLIENT_SECRET)

    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, data=data, auth=auth)
        resp.raise_for_status()
        result = resp.json()

    _cached_token["access_token"] = result["access_token"]
    _cached_token["expires_at"] = time.time() + result.get("expires_in", 3600)
    logger.info("RingCentral access token obtained (expires in %ss).", result.get("expires_in"))
    return result["access_token"]


async def send_sms(to: str, message: str) -> bool:
    """Send an SMS via RingCentral.
    
    Args:
        to: Phone number to send to (e.g. "+19513865263")
        message: Text message body
    
    Returns:
        True on success, False on failure. Never raises.
    """
    if not all([RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT_TOKEN, RC_FROM_NUMBER]):
        logger.info("RingCentral not configured — skipping SMS.")
        return False

    try:
        token = await _get_access_token()

        url = "https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/sms"
        headers = {"Authorization": f"Bearer {token}"}
        payload = {
            "from": {"phoneNumber": RC_FROM_NUMBER},
            "to": [{"phoneNumber": to}],
            "text": message,
        }

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(url, json=payload, headers=headers)

            if resp.is_success:
                logger.info("SMS sent to %s successfully.", to)
                return True
            else:
                logger.warning("RingCentral SMS failed (%s): %s", resp.status_code, resp.text)
                return False

    except Exception as exc:
        logger.error("SMS send error to %s: %s", to, exc)
        return False


async def register_sms_webhook(callback_url: str) -> bool:
    """Register a RingCentral webhook subscription for incoming SMS.

    Creates a subscription so RingCentral POSTs to callback_url
    whenever an SMS is received on Tom's number.
    Returns True on success, False on failure. Never raises.
    """
    if not all([RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT_TOKEN]):
        logger.info("RingCentral not configured — skipping webhook registration.")
        return False

    try:
        token = await _get_access_token()
        headers = {"Authorization": f"Bearer {token}"}

        desired = set(RC_INBOUND_SMS_MMS_FILTERS)
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                "https://platform.ringcentral.com/restapi/v1.0/subscription",
                headers=headers,
            )
            if resp.is_success:
                subs = resp.json().get("records", [])
                for sub in subs:
                    delivery = sub.get("deliveryMode", {})
                    if delivery.get("address", "") != callback_url:
                        continue
                    existing_filters = set(sub.get("eventFilters") or [])
                    if desired.issubset(existing_filters):
                        logger.info(
                            "RingCentral webhook already registered (SMS+MMS) at %s (ID: %s).",
                            callback_url,
                            sub.get("id"),
                        )
                        return True
                    # Replace stale subscription (e.g. SMS-only) so MMS events are delivered.
                    sub_id = sub.get("id")
                    if sub_id:
                        del_resp = await client.delete(
                            f"https://platform.ringcentral.com/restapi/v1.0/subscription/{sub_id}",
                            headers=headers,
                        )
                        if del_resp.is_success:
                            logger.info("Removed outdated RingCentral subscription %s to add MMS filter.", sub_id)
                        else:
                            logger.warning(
                                "Could not delete RingCentral subscription %s (%s): %s",
                                sub_id,
                                del_resp.status_code,
                                del_resp.text[:200],
                            )

            payload = {
                "eventFilters": list(RC_INBOUND_SMS_MMS_FILTERS),
                "deliveryMode": {
                    "transportType": "WebHook",
                    "address": callback_url,
                },
                "expiresIn": 630720000,  # ~20 years (max allowed will be applied by RC)
            }
            resp = await client.post(
                "https://platform.ringcentral.com/restapi/v1.0/subscription",
                json=payload,
                headers=headers,
            )
            if resp.is_success:
                sub_id = resp.json().get("id", "?")
                logger.info(
                    "RingCentral webhook subscription created (SMS+MMS) (ID: %s) → %s",
                    sub_id,
                    callback_url,
                )
                return True
            # Some tenants may reject duplicate MMS filter — retry SMS-only for text-only reliability.
            logger.warning(
                "RingCentral SMS+MMS subscription failed (%s): %s — retrying SMS-only.",
                resp.status_code,
                resp.text[:300],
            )
            payload_sms_only = {
                **payload,
                "eventFilters": [RC_INBOUND_SMS_MMS_FILTERS[0]],
            }
            resp2 = await client.post(
                "https://platform.ringcentral.com/restapi/v1.0/subscription",
                json=payload_sms_only,
                headers=headers,
            )
            if resp2.is_success:
                sub_id = resp2.json().get("id", "?")
                logger.info(
                    "RingCentral webhook subscription created (SMS-only fallback) (ID: %s) → %s",
                    sub_id,
                    callback_url,
                )
                return True
            logger.warning(
                "RingCentral webhook registration failed (%s): %s",
                resp2.status_code,
                resp2.text[:300],
            )
            return False

    except Exception as exc:
        logger.error("RingCentral webhook registration error: %s", exc)
        return False
