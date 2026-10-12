"""Keeping the inbound-SMS subscription in step with the recruiter list.

RingCentral delivers message-store events PER EXTENSION, so the subscription
carries one filter per recruiter extension (see
rc_inbound_subscription.inbound_sms_filters). That list is not static: a
recruiter can finish RingCentral onboarding at any time, and until their
extension is in the subscription their drivers' replies reach nobody — the SMS
they send works, the answer vanishes.

Registering once at startup therefore leaves a hole that only a restart closes.
This reconciles instead: it re-reads the extension list on a slow timer and
re-registers ONLY when the set has actually changed — or when RingCentral has
stopped delivering the subscription — so the steady state costs one internal
request and one RingCentral status read.

Three rules that matter more than they look:

  * a FAILED read is not an empty list. After the first pass, a failure skips
    the tick and leaves the working subscription alone — re-registering with []
    because the hub was briefly unreachable would silently drop every
    recruiter's inbound SMS.
  * the first pass registers regardless, even with an empty list, because the
    shared company number must be watched from boot.
  * an unchanged roster is not proof of a working subscription. RingCentral
    suspends or blacklists a webhook whose address stopped answering (a deploy
    or a crash is enough), and that changes nothing here; only a definite
    "not delivering" re-registers — an unreadable status does not.

Split out of leads-bot/webhook_server.py.
"""
import asyncio
import logging

from rc_inbound_subscription import register_sms_webhook, subscription_active

from .hub_client import _fetch_ringcentral_sms_extensions

logger = logging.getLogger(__name__)

# Slow on purpose: onboarding a recruiter is a human action measured in minutes,
# and the steady-state tick is one cheap internal call.
RC_SUBSCRIPTION_REFRESH_SECONDS = 900
STARTUP_DELAY_SECONDS = 3

_task: asyncio.Task | None = None
# The extension set of the last SUCCESSFUL registration; None until the first.
_registered: frozenset[str] | None = None


def _reset_state_for_tests() -> None:
    """Forget what is registered. Tests only."""
    global _registered
    _registered = None


async def reconcile_rc_subscription(callback_url: str) -> bool:
    """Register the inbound-SMS subscription if the extension set changed, or
    if RingCentral is no longer delivering it.

    Returns True when a registration was performed, False when nothing needed
    doing (or the extension list could not be read on a later pass).
    """
    global _registered
    first_pass = _registered is None

    try:
        extensions = await _fetch_ringcentral_sms_extensions()
    except Exception as exc:
        if not first_pass:
            # Keep the subscription that is working; try again next tick.
            logger.warning("Could not re-read recruiter RingCentral extensions: %s", exc)
            return False
        logger.warning("Could not read recruiter RingCentral extensions: %s", exc)
        extensions = []

    wanted = frozenset(extensions)
    if not first_pass and wanted == _registered:
        if await subscription_active(callback_url) is not False:
            return False
        logger.warning(
            "RingCentral is no longer delivering the inbound-SMS subscription at %s; "
            "registering it again.",
            callback_url,
        )

    logger.info(
        "Registering RingCentral SMS webhook → %s (%d recruiter extension(s))",
        callback_url,
        len(wanted),
    )
    if await register_sms_webhook(callback_url, sorted(wanted)):
        _registered = wanted
        return True

    # Leave _registered as it was so the next tick retries rather than
    # concluding the current set is live.
    logger.warning("RingCentral SMS webhook registration did not succeed; will retry.")
    return False


async def _refresh_loop(callback_url: str) -> None:
    await asyncio.sleep(STARTUP_DELAY_SECONDS)
    while True:
        try:
            await reconcile_rc_subscription(callback_url)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # never let one bad tick end the loop
            logger.error("RingCentral subscription reconcile failed: %s", exc)
        await asyncio.sleep(RC_SUBSCRIPTION_REFRESH_SECONDS)


def start_rc_subscription_refresher(callback_url: str) -> None:
    """Register at boot, then keep the subscription in step with the roster."""
    global _task
    if _task and not _task.done():
        return
    _reset_state_for_tests()
    _task = asyncio.create_task(_refresh_loop(callback_url))


async def stop_rc_subscription_refresher() -> None:
    """Cancel the reconcile loop cleanly."""
    global _task
    if not _task:
        return
    _task.cancel()
    try:
        await _task
    except (asyncio.CancelledError, Exception):
        pass
    _task = None
