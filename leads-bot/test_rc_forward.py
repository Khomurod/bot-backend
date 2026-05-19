"""Unit tests for RingCentral → Telegram MMS forwarding (run from leads-bot/)."""
import os
import unittest
from unittest.mock import AsyncMock, patch

# config.py requires these before importing webhook_server
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "test-telegram-token")
os.environ.setdefault("TELEGRAM_CHAT_ID", "-1001234567890")
os.environ.setdefault("WEBHOOK_VERIFY_TOKEN", "test-verify")
os.environ.setdefault("META_APP_SECRET", "test-meta-secret")
os.environ.setdefault("META_PAGE_ACCESS_TOKEN", "test-page-token")
os.environ.setdefault("LEADS_INTERNAL_SHARED_SECRET", "test-internal-secret")

import webhook_server as wh


class TestRingcentralAttachmentHelpers(unittest.TestCase):
    def test_skips_plain_text_attachment(self):
        body = {
            "attachments": [
                {"type": "Text", "contentType": "text/plain", "uri": "https://example.com/t"}
            ]
        }
        self.assertEqual(wh._ringcentral_media_attachments(body), [])

    def test_keeps_image_by_content_type(self):
        body = {
            "attachments": [
                {"uri": "https://platform.ringcentral.com/restapi/x", "contentType": "image/jpeg"}
            ]
        }
        self.assertEqual(len(wh._ringcentral_media_attachments(body)), 1)

    def test_keeps_mms_attachment_type(self):
        body = {
            "attachments": [
                {
                    "type": "MmsAttachment",
                    "uri": "https://example.com/m",
                    "contentType": "application/octet-stream",
                }
            ]
        }
        self.assertEqual(len(wh._ringcentral_media_attachments(body)), 1)

    def test_telegram_upload_method(self):
        self.assertEqual(wh._telegram_upload_method("image/jpeg")[0], "sendPhoto")
        self.assertEqual(wh._telegram_upload_method("image/png")[0], "sendPhoto")
        self.assertEqual(wh._telegram_upload_method("video/mp4")[0], "sendVideo")
        self.assertEqual(wh._telegram_upload_method("image/heic")[0], "sendDocument")


class TestRingcentralForwardHtml(unittest.TestCase):
    def test_message_body_in_pre_monospace(self):
        html_out = wh._format_ringcentral_forward_html("+15551110000", "Line one\nLine two", "")
        self.assertIn("<pre>", html_out)
        self.assertIn("</pre>", html_out)
        self.assertIn("Line one\nLine two", html_out)
        self.assertIn("<code>+15551110000</code>", html_out)

    def test_escapes_html_in_sms_body(self):
        html_out = wh._format_ringcentral_forward_html("+1", "<script>x</script>", "")
        self.assertNotIn("<script>", html_out)
        self.assertIn("&lt;script&gt;", html_out)

    def test_caption_fit_stays_under_telegram_limit(self):
        long_sms = "W" * 5000
        fitted = wh._fit_ringcentral_caption_html("+15550001111", long_sms, "")
        self.assertLessEqual(len(fitted), 1024)
        self.assertIn("<pre>", fitted)


class TestRingcentralForwardAsync(unittest.IsolatedAsyncioTestCase):
    async def test_text_only_uses_html_send_message(self):
        with patch.object(wh, "_send_telegram_html", new_callable=AsyncMock, return_value=9001) as send_msg:
            with patch.object(wh, "_register_inbound_sms_mirror", new_callable=AsyncMock) as register:
                await wh._forward_ringcentral_inbound_to_telegram(
                    {
                        "from": {"phoneNumber": "+15550001111"},
                        "to": [{"phoneNumber": "+15550002222"}],
                        "subject": "hello",
                        "attachments": [],
                    }
                )
                send_msg.assert_awaited_once()
                text = send_msg.call_args[0][0]
                self.assertIn("<pre>", text)
                self.assertIn("hello", text)
                register.assert_awaited_once_with("+15550001111", "hello", 9001)

    async def test_text_only_skips_register_without_message_id(self):
        with patch.object(wh, "_send_telegram_html", new_callable=AsyncMock, return_value=None):
            with patch.object(wh, "_request_register_sms_mirror", new_callable=AsyncMock) as register_api:
                await wh._forward_ringcentral_inbound_to_telegram(
                    {
                        "from": {"phoneNumber": "+15550001111"},
                        "subject": "hello",
                        "attachments": [],
                    }
                )
                register_api.assert_not_awaited()

    async def test_single_image_send_photo(self):
        fake_png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        with patch.object(
            wh,
            "download_ringcentral_attachment",
            new_callable=AsyncMock,
            return_value=(fake_png, "image/png"),
        ):
            with patch.object(wh, "_send_telegram_upload", new_callable=AsyncMock, return_value=8001) as upload:
                with patch.object(wh, "_register_inbound_sms_mirror", new_callable=AsyncMock) as register:
                    await wh._forward_ringcentral_inbound_to_telegram(
                        {
                            "from": {"phoneNumber": "+15550001111"},
                            "subject": "see pic",
                            "attachments": [
                                {"uri": "https://platform.ringcentral.com/x", "contentType": "image/png"}
                            ],
                        }
                    )
                    upload.assert_awaited()
                    method = upload.call_args[0][0]
                    self.assertEqual(method, "sendPhoto")
                    register.assert_awaited_once_with("+15550001111", "see pic", 8001)

    async def test_two_images_prefers_media_group(self):
        img = b"\xff\xd8\xff\xe0" + b"\x00" * 20
        with patch.object(
            wh,
            "download_ringcentral_attachment",
            new_callable=AsyncMock,
            return_value=(img, "image/jpeg"),
        ):
            with patch.object(
                wh,
                "_send_telegram_media_group_photos",
                new_callable=AsyncMock,
                return_value=7001,
            ) as album:
                with patch.object(wh, "_register_inbound_sms_mirror", new_callable=AsyncMock) as register:
                    await wh._forward_ringcentral_inbound_to_telegram(
                        {
                            "from": {"phoneNumber": "+15550003333"},
                            "subject": "two",
                            "attachments": [
                                {"uri": "https://a/1", "contentType": "image/jpeg"},
                                {"uri": "https://a/2", "contentType": "image/jpeg"},
                            ],
                        }
                    )
                    album.assert_awaited_once()
                    self.assertEqual(len(album.call_args[0][1]), 2)
                    register.assert_awaited_once_with("+15550003333", "two", 7001)

    async def test_media_group_fallback_to_individual(self):
        img = b"\xff\xd8\xff\xe0" + b"\x00" * 20
        with patch.object(
            wh,
            "download_ringcentral_attachment",
            new_callable=AsyncMock,
            return_value=(img, "image/jpeg"),
        ):
            with patch.object(
                wh,
                "_send_telegram_media_group_photos",
                new_callable=AsyncMock,
                return_value=None,
            ):
                with patch.object(
                    wh, "_send_telegram_upload", new_callable=AsyncMock, return_value=6001
                ) as upload:
                    with patch.object(wh, "_register_inbound_sms_mirror", new_callable=AsyncMock) as register:
                        await wh._forward_ringcentral_inbound_to_telegram(
                            {
                                "from": {"phoneNumber": "+15550004444"},
                                "subject": "x",
                                "attachments": [
                                    {"uri": "https://a/1", "contentType": "image/jpeg"},
                                    {"uri": "https://a/2", "contentType": "image/jpeg"},
                                ],
                            }
                        )
                        self.assertEqual(upload.await_count, 2)
                        register.assert_awaited_once_with("+15550004444", "x", 6001)


if __name__ == "__main__":
    unittest.main()
