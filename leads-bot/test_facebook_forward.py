"""Unit tests for verified Facebook payload forwarding (run from repo root or leads-bot/)."""
import hashlib
import hmac
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "test-telegram-token")
os.environ.setdefault("TELEGRAM_CHAT_ID", "-1001234567890")
os.environ.setdefault("WEBHOOK_VERIFY_TOKEN", "test-verify")
os.environ.setdefault("META_APP_SECRET", "test-meta-secret")
os.environ.setdefault("META_PAGE_ACCESS_TOKEN", "test-page-token")
os.environ.setdefault("LEADS_INTERNAL_SHARED_SECRET", "test-internal-secret")
os.environ.setdefault("LOCAL_API_BASE_URL", "http://127.0.0.1:3001")

import webhook_server as wh


class TestFacebookForwardHelpers(unittest.TestCase):
    def test_verify_signature_accepts_matching_hmac(self):
        payload = b'{"object":"page"}'
        signature = hmac.new(
            os.environ["META_APP_SECRET"].encode(),
            payload,
            hashlib.sha256,
        ).hexdigest()
        self.assertTrue(wh._verify_signature(payload, f"sha256={signature}"))

    def test_verify_signature_rejects_wrong_prefix(self):
        self.assertFalse(wh._verify_signature(b"{}", "md5=abc"))

    def test_extract_connect_command_matches_plain_command(self):
        wh._telegram_bot_username = "wenzeleadbots"
        self.assertTrue(wh._extract_connect_command("/connect"))

    def test_extract_connect_command_matches_bot_mention_only_for_this_bot(self):
        wh._telegram_bot_username = "wenzeleadbots"
        self.assertTrue(wh._extract_connect_command("/connect@WenzeLeadBots"))
        self.assertFalse(wh._extract_connect_command("/connect@SomeOtherBot"))


class TestForwardVerifiedPayload(unittest.IsolatedAsyncioTestCase):
    async def test_forward_verified_payload_posts_to_node_api(self):
        fake_response = MagicMock()
        fake_response.is_success = True
        fake_response.json.return_value = {"status": "accepted", "inserted": 2}

        fake_client = AsyncMock()
        fake_client.__aenter__.return_value = fake_client
        fake_client.__aexit__.return_value = None
        fake_client.post.return_value = fake_response

        with patch.object(wh.httpx, "AsyncClient", return_value=fake_client):
            result = await wh._forward_verified_facebook_payload({"object": "page"})

        self.assertEqual(result["inserted"], 2)
        fake_client.post.assert_awaited_once()
        args, kwargs = fake_client.post.await_args
        self.assertEqual(
            args[0],
            f"{os.environ['LOCAL_API_BASE_URL']}/api/internal/facebook/webhook-events",
        )
        self.assertEqual(
            kwargs["headers"]["x-internal-shared-secret"],
            os.environ["LEADS_INTERNAL_SHARED_SECRET"],
        )


if __name__ == "__main__":
    unittest.main()
