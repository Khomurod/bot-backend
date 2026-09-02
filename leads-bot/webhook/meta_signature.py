"""
Meta webhook signature verification.

FAIL-CLOSED, and deliberately its own module so that is easy to audit: any
payload whose X-Hub-Signature-256 does not verify is rejected outright. The
comparison uses hmac.compare_digest, not ==, so a wrong signature cannot be
recovered a byte at a time from response timing.

A missing or malformed header is a failure, not a bypass.

Split out of leads-bot/webhook_server.py.
"""
import hashlib
import hmac

from config import META_APP_SECRET


def _verify_signature(payload: bytes, signature_header: str) -> bool:
    """Validate X-Hub-Signature-256 header from Facebook."""
    if not signature_header.startswith("sha256="):
        return False
    expected = hmac.new(
        META_APP_SECRET.encode(),
        payload,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature_header[7:])
