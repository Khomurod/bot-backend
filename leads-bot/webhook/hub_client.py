"""
Calls from this service into the main Node hub.

Verified Facebook payloads are HANDED OFF rather than processed here: the hub
owns the durable queue, the dedupe ledger and the admin-configured SMS
templates, so a lead that reaches this function is already safe from being
lost or double-sent. That is why the webhook route can answer Meta quickly and
why a retry is just a re-queue.

Every call requires LEADS_INTERNAL_SHARED_SECRET; without it these raise
rather than posting unauthenticated.

Split out of leads-bot/webhook_server.py.
"""
import httpx

from config import LEADS_INTERNAL_SHARED_SECRET, LOCAL_API_BASE_URL


async def _forward_verified_facebook_payload(payload: dict) -> dict:
    """Hand verified Facebook payloads to the main Node app for durable processing."""
    if not LEADS_INTERNAL_SHARED_SECRET:
        raise RuntimeError("LEADS_INTERNAL_SHARED_SECRET is not configured")

    url = f"{LOCAL_API_BASE_URL.rstrip('/')}/api/internal/facebook/webhook-events"
    headers = {"x-internal-shared-secret": LEADS_INTERNAL_SHARED_SECRET}
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(url, json=payload, headers=headers)
        if not resp.is_success:
            raise RuntimeError(f"Internal Facebook ingest failed ({resp.status_code}): {resp.text[:500]}")
        return resp.json()


async def _fetch_ringcentral_sms_extensions() -> list[str]:
    """RingCentral extension ids inbound SMS must be watched on.

    Recruiters send lead texts from their own numbers, each a separate
    extension, and RingCentral delivers message-store events per extension. The
    hub owns the recruiter list, so it is asked rather than guessed.

    A FAILURE RAISES; it does not return []. The caller distinguishes the two:
    an empty roster means "no recruiter has their own number yet" and is
    re-registered, while a failed read leaves the working subscription alone
    (reconcile_rc_subscription). Returning [] for a failure collapses those
    into one, and re-registering with no extensions because the hub was
    briefly unreachable silently drops every recruiter's inbound SMS.

    A missing shared secret used to be the exception — it returned [] — so a
    misconfigured deployment looked exactly like a company with no recruiters
    onboarded, with no warning anywhere.
    """
    if not LEADS_INTERNAL_SHARED_SECRET:
        raise RuntimeError(
            "LEADS_INTERNAL_SHARED_SECRET is not set, so the recruiter extension list "
            "cannot be read; inbound SMS can only be watched on the shared number."
        )

    url = f"{LOCAL_API_BASE_URL.rstrip('/')}/api/internal/ringcentral/sms-extensions"
    headers = {"x-internal-shared-secret": LEADS_INTERNAL_SHARED_SECRET}
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(url, headers=headers)
        if not resp.is_success:
            raise RuntimeError(f"Extension list unavailable ({resp.status_code}): {resp.text[:300]}")
        data = resp.json() if resp.content else {}
    extensions = data.get("extensions") or []
    return [str(item).strip() for item in extensions if str(item).strip()]


async def _forward_retry_leadgen_to_node(leadgen_id: str) -> dict:
    """Re-queue a lead through the Node worker (uses admin-configured SMS templates)."""
    if not LEADS_INTERNAL_SHARED_SECRET:
        raise RuntimeError("LEADS_INTERNAL_SHARED_SECRET is not configured")

    url = f"{LOCAL_API_BASE_URL.rstrip('/')}/api/internal/facebook/retry-leadgen"
    headers = {"x-internal-shared-secret": LEADS_INTERNAL_SHARED_SECRET}
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json={"leadgenId": leadgen_id}, headers=headers)
        if resp.status_code == 404:
            return {"status": "not_found"}
        if not resp.is_success:
            raise RuntimeError(f"Internal lead retry failed ({resp.status_code}): {resp.text[:500]}")
        return resp.json()
