"""
RingCentral access for the inbound side: the JWT access token, and the
download of an inbound picture message's attachments. Texts to candidates are
sent by the Node hub (the recruiter SMS sender), never from here. The
subscription that brings inbound SMS here is rc_inbound_subscription.py.

If RingCentral credentials are not configured, all functions are no-ops.
"""
import logging
import httpx
from config import RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT_TOKEN

logger = logging.getLogger(__name__)

# Cache the access token so we don't re-auth on every call
_cached_token: dict = {"access_token": "", "expires_at": 0}

# Base URL for relative attachment URIs from webhook payloads
RC_PLATFORM_BASE = "https://platform.ringcentral.com"


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
