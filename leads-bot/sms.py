"""
RingCentral SMS sender.

Sends an auto-response SMS to new leads via the RingCentral REST API.
Uses JWT authentication for a permanent, non-expiring connection.

If RingCentral credentials are not configured, all functions are no-ops.
"""
import logging
import re
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


def valid_extension_ids(
    extension_ids: list[str] | tuple[str, ...] | None = None,
) -> tuple[list[str], list[str]]:
    """Split a roster into ids that can become a filter, and ones that cannot.

    A RingCentral extension id is a number. Anything else interpolated into a
    filter path makes the WHOLE subscription invalid —
    `CMN-101 Parameter [eventFilters] value is invalid` — and the old code then
    dropped every recruiter's filter rather than the one bad value, so one
    malformed row silently cost every recruiter their inbound SMS.

    Refusing it here means the request that goes out is one RingCentral can
    accept, and the offending value is named in a log instead of being invisible
    inside a rejected payload.

    Returns (usable, rejected), both in the order given, de-duplicated.
    """
    usable: list[str] = []
    rejected: list[str] = []
    seen: set[str] = set()
    for ext_id in extension_ids or ():
        if ext_id is None:
            # A hole in the roster is not a bad id — nothing to report.
            continue
        ext = str(ext_id).strip()
        if not ext or ext == "~":
            # `~` is the shared extension, always covered by the base filters.
            continue
        if ext in seen:
            continue
        seen.add(ext)
        if ext.isdigit():
            usable.append(ext)
        else:
            rejected.append(ext)
    return usable, rejected


def extension_filters(extension_id: str, *, include_mms: bool = True) -> list[str]:
    """The SMS (and optionally MMS) filters for one extension."""
    base = f"/restapi/v1.0/account/~/extension/{extension_id}/message-store/instant"
    return [f"{base}?type=SMS"] + ([f"{base}?type=MMS"] if include_mms else [])


def _extensions_in(filters: list[str] | tuple[str, ...]) -> set[str]:
    """Which extension ids a set of filters actually watches.

    Used to say, precisely, which recruiters a degraded subscription lost —
    rather than the old blanket "WITHOUT per-recruiter extensions", which was
    wrong whenever the roster was empty or only MMS had been given up.
    """
    found: set[str] = set()
    for item in filters or ():
        match = re.search(r"/extension/([^/]+)/message-store", str(item))
        if match and match.group(1) != "~":
            found.add(match.group(1))
    return found


def inbound_sms_filters(
    extension_ids: list[str] | tuple[str, ...] | None = None,
    *,
    include_mms: bool = True,
) -> list[str]:
    """Event filters covering the shared extension plus each recruiter's own.

    `~` is the extension the subscribing JWT belongs to — the shared company
    number. Every recruiter who now texts leads from their OWN number is a
    DIFFERENT extension, and RingCentral delivers message-store events per
    extension, so each one needs its own filter or their drivers' replies never
    reach Telegram.

    Watching another extension requires the subscribing user to be an account
    admin; when that is refused, register_sms_webhook() sheds extensions one at
    a time rather than losing every recruiter at once.
    """
    filters = list(RC_INBOUND_SMS_MMS_FILTERS if include_mms else RC_INBOUND_SMS_MMS_FILTERS[:1])
    usable, _rejected = valid_extension_ids(extension_ids)
    for ext in usable:
        filters.extend(extension_filters(ext, include_mms=include_mms))
    # De-duplicate while keeping order: `~` may also appear as an explicit id.
    seen: set[str] = set()
    unique: list[str] = []
    for item in filters:
        if item not in seen:
            seen.add(item)
            unique.append(item)
    return unique


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


async def register_sms_webhook(
    callback_url: str,
    extension_ids: list[str] | tuple[str, ...] | None = None,
) -> bool:
    """Register a RingCentral webhook subscription for incoming SMS.

    Creates a subscription so RingCentral POSTs to callback_url whenever an SMS
    arrives on the shared company number or on any recruiter extension in
    `extension_ids`. Returns True on success, False on failure. Never raises.
    """
    if not all([RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT_TOKEN]):
        logger.info("RingCentral not configured — skipping webhook registration.")
        return False

    try:
        token = await _get_access_token()
        headers = {"Authorization": f"Bearer {token}"}

        usable_extensions, rejected_extensions = valid_extension_ids(extension_ids)
        if rejected_extensions:
            logger.warning(
                "Ignoring %d unusable RingCentral extension id(s) — a non-numeric id makes the "
                "WHOLE subscription invalid (CMN-101), so it is refused here instead: %s",
                len(rejected_extensions),
                ", ".join(rejected_extensions),
            )
        wanted_filters = inbound_sms_filters(usable_extensions)
        desired = set(wanted_filters)
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
                "eventFilters": wanted_filters,
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
                    "RingCentral webhook subscription created (%d filter(s)) (ID: %s) → %s",
                    len(wanted_filters),
                    sub_id,
                    callback_url,
                )
                return True

            # Watching another extension needs an admin subscriber, and some
            # tenants also reject the MMS filter. Shed capability in the order
            # that costs least, and keep every recruiter we still can: dropping
            # ALL of them because one was refused is how a single bad row used
            # to take out everybody's inbound SMS.
            #
            # The filters are logged in full. They carry no secret — an account
            # id is `~` and the rest is an extension number — and without them
            # a rejected id is invisible in production.
            logger.warning(
                "RingCentral subscription with %d filter(s) failed (%s): %s — filters were: %s",
                len(wanted_filters),
                resp.status_code,
                resp.text[:300],
                ", ".join(wanted_filters),
            )

            attempts: list[tuple[str, list[str]]] = []
            # 1. SMS only for the extras (MMS is the commonest tenant refusal).
            if usable_extensions:
                attempts.append((
                    f"{len(usable_extensions)} recruiter extension(s), SMS only",
                    inbound_sms_filters(usable_extensions, include_mms=False),
                ))
            # 2. Leave ONE extension out at a time, so the unwatchable one is
            #    isolated wherever it sits in the roster.
            #
            #    Shedding a SUFFIX instead — the obvious version — only works if
            #    the bad extension happens to be last. reconcile_rc_subscription
            #    passes the roster `sorted()` by id, which has nothing to do with
            #    which one RingCentral refuses, so a bad id at the front stayed in
            #    every attempt and every recruiter still lost their inbound SMS.
            for excluded in usable_extensions:
                kept = [ext for ext in usable_extensions if ext != excluded]
                if not kept:
                    continue  # covered by the shared-only attempts below
                attempts.append((
                    f"every recruiter extension except {excluded}",
                    inbound_sms_filters(kept),
                ))
            # 3. The shared number alone, with and then without MMS. One number
            #    covered beats none.
            attempts.append(("the shared extension only", list(RC_INBOUND_SMS_MMS_FILTERS)))
            attempts.append(("the shared extension only, SMS only", [RC_INBOUND_SMS_MMS_FILTERS[0]]))

            tried: set[tuple[str, ...]] = {tuple(wanted_filters)}
            for description, fallback_filters in attempts:
                key = tuple(fallback_filters)
                if key in tried:
                    continue
                tried.add(key)
                retry = await client.post(
                    "https://platform.ringcentral.com/restapi/v1.0/subscription",
                    json={**payload, "eventFilters": fallback_filters},
                    headers=headers,
                )
                if not retry.is_success:
                    logger.warning(
                        "RingCentral webhook registration with %s failed (%s): %s",
                        description,
                        retry.status_code,
                        retry.text[:300],
                    )
                    continue

                sub_id = retry.json().get("id", "?")
                covered = _extensions_in(fallback_filters)
                dropped = [ext for ext in usable_extensions if ext not in covered]
                if dropped:
                    logger.warning(
                        "RingCentral webhook subscription created with %s (ID: %s) → %s. "
                        "Extension(s) %s are NOT watched, so replies to those recruiters' "
                        "numbers will not reach Telegram.",
                        description,
                        sub_id,
                        callback_url,
                        ", ".join(dropped),
                    )
                else:
                    # No recruiter was lost: what we gave up was MMS on a number
                    # we ARE watching. Saying "without per-recruiter extensions"
                    # here — as this used to, even for an empty roster — sends an
                    # operator looking for the wrong problem.
                    logger.warning(
                        "RingCentral webhook subscription created with %s (ID: %s) → %s. "
                        "Every recruiter extension is still watched; picture messages (MMS) "
                        "are not delivered.",
                        description,
                        sub_id,
                        callback_url,
                    )
                return True
            return False

    except Exception as exc:
        logger.error("RingCentral webhook registration error: %s", exc)
        return False
