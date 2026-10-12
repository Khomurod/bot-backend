"""Fakes for the RingCentral subscription tests: a scripted httpx client and
the subscription records RingCentral lists. Not a test module itself (the
runner collects test_*.py); test_rc_webhook_register.py and
test_rc_existing_subscription.py share it.
"""
import asyncio
import os
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "test-telegram-token")
os.environ.setdefault("TELEGRAM_CHAT_ID", "-1001234567890")
os.environ.setdefault("WEBHOOK_VERIFY_TOKEN", "test-verify")
os.environ.setdefault("META_APP_SECRET", "test-meta-secret")
os.environ.setdefault("LEADS_INTERNAL_SHARED_SECRET", "test-internal-secret")
os.environ.setdefault("RC_CLIENT_ID", "test-client-id")
os.environ.setdefault("RC_CLIENT_SECRET", "test-client-secret")
os.environ.setdefault("RC_JWT_TOKEN", "test-jwt")

import rc_inbound_subscription as rcin  # noqa: E402

CALLBACK = "https://wenze.test/rc-webhook"


def response(status_code=200, json_body=None, text=""):
    resp = MagicMock()
    resp.status_code = status_code
    resp.is_success = 200 <= status_code < 300
    resp.json.return_value = json_body if json_body is not None else {}
    resp.text = text
    resp.content = b"{}"
    return resp


class FakeClient:
    """An httpx.AsyncClient stand-in that scripts the POST answers.

    `rc_inbound_subscription.py` builds its client inline, so the transport is
    the seam — the same approach webhook_server.py documents at its
    `import httpx` line. `calls` keeps the order of POSTs and DELETEs.
    """

    def __init__(self, post_responses, get_response=None):
        self._post_responses = list(post_responses)
        self._get_response = get_response or response(200, {"records": []})
        self.posts = []
        self.deletes = []
        self.calls = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def get(self, url, headers=None):
        return self._get_response

    async def post(self, url, json=None, headers=None):
        self.posts.append(json or {})
        self.calls.append("post")
        if self._post_responses:
            return self._post_responses.pop(0)
        return response(400, text="unexpected extra POST")

    async def delete(self, url, headers=None):
        self.deletes.append(url)
        self.calls.append("delete")
        return response(200)


def patched(client, coro_factory):
    """Run `coro_factory()` with `client` standing in for httpx.

    The RC_* credentials are patched on the module rather than set in the
    environment: `rc_inbound_subscription.py` binds them at import time, so
    whether an env var was set in time depends on which test file the runner
    imported first. Patching the constants makes this independent of that order.
    """
    with patch.object(rcin, "RC_CLIENT_ID", "test-client-id"), \
         patch.object(rcin, "RC_CLIENT_SECRET", "test-client-secret"), \
         patch.object(rcin, "RC_JWT_TOKEN", "test-jwt"), \
         patch.object(rcin, "_get_access_token", new=AsyncMock(return_value="tok")), \
         patch.object(rcin, "httpx") as httpx_mod:
        httpx_mod.AsyncClient.return_value = client
        return asyncio.run(coro_factory())


def run(client, extensions):
    """Register with `client` standing in for httpx, returning (ok, client)."""
    return patched(client, lambda: rcin.register_sms_webhook(CALLBACK, extensions)), client


def ours(sub_id, status="Active", extensions=("101",)):
    """A subscription record delivering to CALLBACK, as RingCentral lists it."""
    return {
        "id": sub_id,
        "status": status,
        "deliveryMode": {"address": CALLBACK},
        "eventFilters": rcin.inbound_sms_filters(list(extensions)),
    }


def listing(*records):
    return response(200, {"records": list(records)})
