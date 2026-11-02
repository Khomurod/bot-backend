"""Whether a POST to /rc-webhook came from OUR RingCentral subscription.

`/rc-webhook` is public: RingCentral has to reach it. RingCentral's validation
handshake only proves the address answers. It says nothing about the
notifications that follow, so anybody could post a made-up "inbound SMS". That
fake would land in the leads Telegram group as a candidate's reply and, outside
working hours, reach the after-hours reply (November 2026, found in review).

RingCentral's own answer is the subscription's `deliveryMode.verificationToken`.
It is echoed back as a `Verification-Token` header on every notification of
that subscription. There is no signature, so this shared value IS the check.

THE TOKEN IS DERIVED, NOT CONFIGURED. It is an HMAC of
LEADS_INTERNAL_SHARED_SECRET (which falls back to JWT_SECRET, so it is always
set where this service works at all) under a fixed label. No new variable can
be forgotten on a deploy. Changing the secret changes the token, and a restart
then registers a subscription that carries the new one
(webhook/rc_subscription.py registers afresh on every boot).

NOTHING THAT IS REALLY RINGCENTRAL IS LOST WHILE THIS TAKES OVER. Until this
process has registered a subscription carrying the token ("armed"), a
notification WITHOUT the header is still accepted, and logged. Until then the
only live subscription may be the one registered before this existed. Once
armed, a missing header is refused. A WRONG token is refused always: nothing
real ever sends one.
"""
import hashlib
import hmac

from config import LEADS_INTERNAL_SHARED_SECRET

_LABEL = b"wenze/ringcentral-webhook-verification-token/v1"
# 32 hex characters: 128 bits, well inside what RingCentral takes.
TOKEN_LENGTH = 32

ACCEPT = "accept"
ACCEPT_UNVERIFIED = "accept_unverified"
REJECT = "reject"

_armed = False


def verification_token(secret: str | None = None) -> str | None:
    """The token our subscription carries; None when there is no secret to derive it from."""
    source = LEADS_INTERNAL_SHARED_SECRET if secret is None else secret
    if not source:
        return None
    return hmac.new(source.encode("utf-8"), _LABEL, hashlib.sha256).hexdigest()[:TOKEN_LENGTH]


def arm() -> None:
    """A subscription carrying the token is registered: refuse anything without it from now on."""
    global _armed
    _armed = True


def is_armed() -> bool:
    return _armed


def _reset_for_tests() -> None:
    global _armed
    _armed = False


def verdict(received: str | None, *, expected: str | None, armed: bool) -> str:
    """What to do with one notification, from its Verification-Token header. Pure.

    - the right token: ACCEPT;
    - a wrong token: REJECT, armed or not — RingCentral never sends one;
    - no token: REJECT once armed; before that ACCEPT_UNVERIFIED (the
      subscription registered before tokens existed may still be the live one);
    - nothing to compare with (no secret): ACCEPT_UNVERIFIED — the behaviour
      before this check, never a reason to drop a candidate's message.
    """
    if not expected:
        return ACCEPT_UNVERIFIED
    if received:
        # Bytes, not str: compare_digest refuses a str with non-ASCII characters,
        # and a forged header can carry anything.
        given = received.strip().encode("utf-8", "replace")
        return ACCEPT if hmac.compare_digest(given, expected.encode("utf-8")) else REJECT
    return REJECT if armed else ACCEPT_UNVERIFIED
