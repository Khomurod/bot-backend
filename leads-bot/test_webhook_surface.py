"""What this service exposes, and the dead code that stays removed.

The hidden-functions audit (block 4c) removed code nothing ran. Python verifies
Meta's signature and hands the whole payload to the Node queue, which handles
leads and Messenger, so the in-process Messenger handler, graph.py and the
sender-dedupe file went. Texts to candidates are sent by Node, so send_sms went.
GET /retry/{id} and GET /leads-log sat on this service's internal port, which
the hub never proxies (only /webhook and /rc-webhook), and /retry was a GET that
re-queued a lead; the admin panel's Webhook log has its own guarded retry.
"""
import importlib.util
import os
import unittest

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "test-telegram-token")
os.environ.setdefault("TELEGRAM_CHAT_ID", "-1001234567890")
os.environ.setdefault("WEBHOOK_VERIFY_TOKEN", "test-verify")
os.environ.setdefault("META_APP_SECRET", "test-meta-secret")
os.environ.setdefault("LEADS_INTERNAL_SHARED_SECRET", "test-internal-secret")
os.environ.setdefault("LOCAL_API_BASE_URL", "http://127.0.0.1:3001")

from fastapi.routing import APIRoute  # noqa: E402

import sms  # noqa: E402
import webhook_server as wh  # noqa: E402
from webhook import hub_client, telegram_client  # noqa: E402


class TestWebhookSurface(unittest.TestCase):
    def test_the_routes_are_exactly_the_front_door(self):
        routes = sorted(
            (route.path, method)
            for route in wh.app.routes
            if isinstance(route, APIRoute)
            for method in route.methods
            if method != "HEAD"
        )
        self.assertEqual(
            routes,
            [
                ("/", "GET"),
                ("/health", "GET"),
                ("/rc-webhook", "POST"),
                ("/webhook", "GET"),
                ("/webhook", "POST"),
            ],
        )

    def test_the_removed_modules_stay_removed(self):
        for name in ("graph", "webhook.lead_processing", "webhook.state"):
            self.assertIsNone(importlib.util.find_spec(name), f"{name} must not come back")

    def test_the_removed_functions_stay_removed(self):
        self.assertFalse(hasattr(sms, "send_sms"))
        self.assertFalse(hasattr(hub_client, "_forward_retry_leadgen_to_node"))
        for name in ("_send_telegram", "_edit_telegram"):
            self.assertFalse(hasattr(telegram_client, name), name)
        # What the inbound side still needs is here.
        self.assertTrue(callable(sms.download_ringcentral_attachment))
        self.assertTrue(callable(telegram_client._send_telegram_html))


if __name__ == "__main__":
    unittest.main()
