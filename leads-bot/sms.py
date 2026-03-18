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

        # Check for existing subscriptions to avoid duplicates
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                "https://platform.ringcentral.com/restapi/v1.0/subscription",
                headers=headers,
            )
            if resp.is_success:
                subs = resp.json().get("records", [])
                for sub in subs:
                    delivery = sub.get("deliveryMode", {})
                    if delivery.get("address", "") == callback_url:
                        logger.info("RingCentral webhook already registered at %s (ID: %s).", callback_url, sub.get("id"))
                        return True

            # Create new subscription
            payload = {
                "eventFilters": [
                    "/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS"
                ],
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
                logger.info("RingCentral webhook subscription created (ID: %s) → %s", sub_id, callback_url)
                return True
            else:
                logger.warning("RingCentral webhook registration failed (%s): %s", resp.status_code, resp.text[:300])
                return False

    except Exception as exc:
        logger.error("RingCentral webhook registration error: %s", exc)
        return False
