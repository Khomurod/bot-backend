"""
The RingCentral subscription that brings inbound SMS to this service.

Which filters it carries (one per watched extension), registering it, and
checking that RingCentral is still delivering it. webhook/rc_subscription.py
decides WHEN to do each; this module does it. Split out of sms.py, which keeps
sending SMS and fetching attachments.

If RingCentral credentials are not configured, every function is a no-op.
"""
import logging
import re

import httpx

from config import RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT_TOKEN
from sms import _get_access_token

logger = logging.getLogger(__name__)

RC_SUBSCRIPTION_URL = "https://platform.ringcentral.com/restapi/v1.0/subscription"

# The one event filter RingCentral has for inbound texts, on the shared number.
# Picture messages come through it too: RingCentral sends an MMS as
# `"type": "SMS"` with an `MmsAttachment`, which webhook/ringcentral.py
# downloads and forwards.
#
# There is no `?type=MMS` filter. The subscription used to ask for one as well,
# so RingCentral refused EVERY first attempt (CMN-101), the SMS-only retry then
# worked, and each boot logged "picture messages (MMS) are not delivered" —
# untrue, and the working subscription was deleted and re-created every time,
# because the one found never had the MMS filter it was looking for.
RC_INBOUND_SMS_FILTER = "/restapi/v1.0/account/~/extension/~/message-store/instant?type=SMS"


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


def extension_filter(extension_id: str) -> str:
    """The inbound-text filter for one extension (pictures included, as above)."""
    return f"/restapi/v1.0/account/~/extension/{extension_id}/message-store/instant?type=SMS"


def _extensions_in(filters: list[str] | tuple[str, ...]) -> set[str]:
    """Which extension ids a set of filters actually watches.

    Used to say, precisely, which recruiters a degraded subscription lost —
    rather than the old blanket "WITHOUT per-recruiter extensions", which was
    wrong whenever the roster was empty.
    """
    found: set[str] = set()
    for item in filters or ():
        match = re.search(r"/extension/([^/]+)/message-store", str(item))
        if match and match.group(1) != "~":
            found.add(match.group(1))
    return found


def inbound_sms_filters(
    extension_ids: list[str] | tuple[str, ...] | None = None,
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

    One filter per extension, never a duplicate: valid_extension_ids() drops
    `~` and repeats, so no id can produce the shared filter again.
    """
    usable, _rejected = valid_extension_ids(extension_ids)
    return [RC_INBOUND_SMS_FILTER] + [extension_filter(ext) for ext in usable]


def _is_active(subscription: dict) -> bool:
    """Whether RingCentral is still delivering this subscription's events.

    RingCentral suspends or blacklists a webhook whose address stopped
    answering. Such a subscription has the right filters and delivers nothing,
    so it must be replaced, not kept.
    """
    return str(subscription.get("status") or "").strip().lower() == "active"


def _is_transient(resp) -> bool:
    """RingCentral could not answer just now: rate limit, timeout or outage.

    That is not a verdict on the filters, so it must never shed a recruiter. A
    fallback that then worked would be recorded as the whole roster, and the
    recruiter it left out would stay unwatched until the roster next changed.
    """
    return resp.status_code in (408, 429) or resp.status_code >= 500


_UNAVAILABLE = (
    "RingCentral could not take the subscription request just now (%s). No "
    "recruiter is dropped for that: what is registered stays, and the next pass "
    "tries again."
)


async def _subscriptions_at(client, headers: dict, callback_url: str) -> list[dict] | None:
    """The subscriptions delivering to callback_url; None if RingCentral would not list them."""
    resp = await client.get(RC_SUBSCRIPTION_URL, headers=headers)
    if not resp.is_success:
        logger.warning(
            "Could not list RingCentral subscriptions (%s): %s", resp.status_code, resp.text[:200]
        )
        return None
    return [
        sub for sub in resp.json().get("records", [])
        if (sub.get("deliveryMode") or {}).get("address", "") == callback_url
    ]


async def _delete_subscriptions(client, headers: dict, subscriptions: list[dict]) -> None:
    """Delete subscriptions that another one at the same address now covers.

    A failure is logged, never raised: the one that covers them is already
    delivering, and a leftover only sends the same message twice.
    """
    for sub in subscriptions:
        sub_id = sub.get("id")
        if not sub_id:
            continue
        try:
            resp = await client.delete(f"{RC_SUBSCRIPTION_URL}/{sub_id}", headers=headers)
        except Exception as exc:
            logger.warning("Could not delete RingCentral subscription %s: %s", sub_id, exc)
            continue
        if resp.is_success:
            logger.info(
                "Removed RingCentral subscription %s (status %s): another one at this "
                "address watches the current extensions.",
                sub_id,
                sub.get("status") or "unknown",
            )
        else:
            logger.warning(
                "Could not delete RingCentral subscription %s (%s): %s",
                sub_id,
                resp.status_code,
                resp.text[:200],
            )


async def subscription_active(callback_url: str) -> bool | None:
    """Whether RingCentral is still delivering inbound SMS to callback_url.

    True when an Active subscription for that address exists. False when none
    does: RingCentral suspends or blacklists a webhook whose address stopped
    answering, and one can be deleted by hand. None when it cannot be told —
    no credentials, or RingCentral unreachable — which is evidence of nothing.
    """
    if not all([RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT_TOKEN]):
        return None
    try:
        token = await _get_access_token()
        async with httpx.AsyncClient(timeout=15) as client:
            ours = await _subscriptions_at(client, {"Authorization": f"Bearer {token}"}, callback_url)
    except Exception as exc:
        logger.warning("Could not check the RingCentral subscription: %s", exc)
        return None
    if ours is None:
        return None
    return any(_is_active(sub) for sub in ours)


async def register_sms_webhook(
    callback_url: str,
    extension_ids: list[str] | tuple[str, ...] | None = None,
) -> bool:
    """Register a RingCentral webhook subscription for incoming SMS.

    Creates a subscription so RingCentral POSTs to callback_url whenever an SMS
    — or a picture message, which arrives the same way — reaches the shared
    company number or any recruiter extension in `extension_ids`. An active
    subscription that already covers them is kept. Returns True on success,
    False on failure. Never raises.
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
            ours = await _subscriptions_at(client, headers, callback_url) or []
            keep = next(
                (sub for sub in ours if desired.issubset(set(sub.get("eventFilters") or [])) and _is_active(sub)),
                None,
            )
            if keep is not None:
                logger.info("RingCentral webhook already registered at %s (ID: %s).", callback_url, keep.get("id"))
                await _delete_subscriptions(client, headers, [sub for sub in ours if sub is not keep])
                return True
            # What is registered now is deleted only once its successor exists.
            # One that misses a new recruiter still delivers for everybody else,
            # and deleting it first left nothing watching whenever RingCentral
            # then refused or failed the new request.

            payload = {
                "eventFilters": wanted_filters,
                "deliveryMode": {
                    "transportType": "WebHook",
                    "address": callback_url,
                },
                "expiresIn": 630720000,  # ~20 years (max allowed will be applied by RC)
            }
            resp = await client.post(RC_SUBSCRIPTION_URL, json=payload, headers=headers)
            if resp.is_success:
                sub_id = resp.json().get("id", "?")
                logger.info(
                    "RingCentral webhook subscription created (%d filter(s)) (ID: %s) → %s",
                    len(wanted_filters),
                    sub_id,
                    callback_url,
                )
                await _delete_subscriptions(client, headers, ours)
                return True

            # Watching another extension needs an admin subscriber. Keep every
            # recruiter we still can: dropping ALL of them because one was
            # refused is how a single bad row used to take out everybody's
            # inbound SMS.
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
            if _is_transient(resp):
                logger.warning(_UNAVAILABLE, resp.status_code)
                return False

            attempts: list[tuple[str, list[str]]] = []
            # 1. Leave ONE extension out at a time, so the unwatchable one is
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
                    continue  # covered by the shared-only attempt below
                attempts.append((
                    f"every recruiter extension except {excluded}",
                    inbound_sms_filters(kept),
                ))
            # 2. The shared number alone. One number covered beats none. With
            #    no recruiter extensions this IS the request that just failed,
            #    so it is skipped and the caller retries on its next tick.
            attempts.append(("the shared extension only", [RC_INBOUND_SMS_FILTER]))

            tried: set[tuple[str, ...]] = {tuple(wanted_filters)}
            for description, fallback_filters in attempts:
                key = tuple(fallback_filters)
                if key in tried:
                    continue
                tried.add(key)
                retry = await client.post(
                    RC_SUBSCRIPTION_URL,
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
                    if _is_transient(retry):
                        logger.warning(_UNAVAILABLE, retry.status_code)
                        return False
                    continue

                # Every fallback leaves out at least one recruiter extension,
                # so a fallback that works always says whose replies are lost.
                sub_id = retry.json().get("id", "?")
                covered = _extensions_in(fallback_filters)
                dropped = [ext for ext in usable_extensions if ext not in covered]
                logger.warning(
                    "RingCentral webhook subscription created with %s (ID: %s) → %s. "
                    "Extension(s) %s are NOT watched, so replies to those recruiters' "
                    "numbers will not reach Telegram.",
                    description,
                    sub_id,
                    callback_url,
                    ", ".join(dropped),
                )
                await _delete_subscriptions(client, headers, ours)
                return True
            return False

    except Exception as exc:
        logger.error("RingCentral webhook registration error: %s", exc)
        return False
