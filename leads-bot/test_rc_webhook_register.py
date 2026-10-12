"""register_sms_webhook — the request that decides whose replies reach Telegram.

This function had NO tests: every reference to it in the suite was a mock, so
nothing covered the payload it sends or what it does when RingCentral refuses.
Production then reported

    CMN-101 Parameter [eventFilters] value is invalid

followed by a fallback that dropped EVERY recruiter's filter — one unusable
extension id cost the whole roster its inbound SMS, and the log printed only a
filter count, so the offending value was invisible.

What is pinned here: the filters that actually go out, that a malformed id is
refused locally rather than sent, that a refusal sheds one extension at a time
instead of all of them, and that the warning names what was really lost.

Also pinned: no `?type=MMS` filter is ever sent. RingCentral has none — a
picture message arrives through the SMS filter — and sending one made every
first attempt fail, every boot warn that pictures were not delivered (they
were), and every registration delete the working subscription and make a new
one.
"""
import asyncio
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "test-telegram-token")
os.environ.setdefault("TELEGRAM_CHAT_ID", "-1001234567890")
os.environ.setdefault("WEBHOOK_VERIFY_TOKEN", "test-verify")
os.environ.setdefault("META_APP_SECRET", "test-meta-secret")
os.environ.setdefault("LEADS_INTERNAL_SHARED_SECRET", "test-internal-secret")
os.environ.setdefault("RC_CLIENT_ID", "test-client-id")
os.environ.setdefault("RC_CLIENT_SECRET", "test-client-secret")
os.environ.setdefault("RC_JWT_TOKEN", "test-jwt")

import sms  # noqa: E402

CALLBACK = "https://wenze.test/rc-webhook"


def _response(status_code=200, json_body=None, text=""):
    resp = MagicMock()
    resp.status_code = status_code
    resp.is_success = 200 <= status_code < 300
    resp.json.return_value = json_body if json_body is not None else {}
    resp.text = text
    resp.content = b"{}"
    return resp


class FakeClient:
    """An httpx.AsyncClient stand-in that scripts the POST answers.

    `sms.py` builds its client inline, so the transport is the seam — the same
    approach webhook_server.py documents at its `import httpx` line.
    """

    def __init__(self, post_responses, get_response=None):
        self._post_responses = list(post_responses)
        self._get_response = get_response or _response(200, {"records": []})
        self.posts = []
        self.deletes = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def get(self, url, headers=None):
        return self._get_response

    async def post(self, url, json=None, headers=None):
        self.posts.append(json or {})
        if self._post_responses:
            return self._post_responses.pop(0)
        return _response(400, text="unexpected extra POST")

    async def delete(self, url, headers=None):
        self.deletes.append(url)
        return _response(200)


def _run(client, extensions):
    """Register with `client` standing in for httpx, returning (ok, client).

    The RC_* credentials are patched on the module rather than set in the
    environment: `sms.py` binds them at import time, so whether an env var was
    set in time depends on which test file the runner imported first. Patching
    the constants makes this independent of that order.
    """
    with patch.object(sms, "RC_CLIENT_ID", "test-client-id"), \
         patch.object(sms, "RC_CLIENT_SECRET", "test-client-secret"), \
         patch.object(sms, "RC_JWT_TOKEN", "test-jwt"), \
         patch.object(sms, "_get_access_token", new=AsyncMock(return_value="tok")), \
         patch.object(sms, "httpx") as httpx_mod:
        httpx_mod.AsyncClient.return_value = client
        ok = asyncio.run(sms.register_sms_webhook(CALLBACK, extensions))
    return ok, client


class ValidExtensionIdsTests(unittest.TestCase):
    def test_keeps_numeric_ids_in_order_without_duplicates(self):
        usable, rejected = sms.valid_extension_ids(["101", "102", "101", " 103 "])
        self.assertEqual(usable, ["101", "102", "103"])
        self.assertEqual(rejected, [])

    def test_refuses_anything_that_is_not_a_number(self):
        # A non-numeric id interpolated into a filter path invalidates the WHOLE
        # subscription, so it must never reach RingCentral.
        usable, rejected = sms.valid_extension_ids(["101", "not-an-id", "", None, "8005551212"])
        self.assertEqual(usable, ["101", "8005551212"])
        self.assertEqual(rejected, ["not-an-id"])

    def test_the_shared_extension_is_never_an_extra(self):
        usable, rejected = sms.valid_extension_ids(["~", "101"])
        self.assertEqual(usable, ["101"])
        self.assertEqual(rejected, [])


def _refuses_mms_filters():
    """A client that answers like RingCentral: a `?type=MMS` filter is invalid."""

    class RingCentralLike(FakeClient):
        async def post(self, url, json=None, headers=None):
            self.posts.append(json or {})
            if any("type=MMS" in f for f in (json or {}).get("eventFilters", [])):
                return _response(400, text="CMN-101 Parameter [eventFilters] value is invalid")
            return _response(200, {"id": f"sub-{len(self.posts)}"})

    return RingCentralLike([])


class InboundSmsFiltersTests(unittest.TestCase):
    def test_shared_extension_is_always_covered(self):
        self.assertEqual(sms.inbound_sms_filters([]), [sms.RC_INBOUND_SMS_FILTER])

    def test_each_recruiter_extension_gets_one_filter(self):
        self.assertEqual(sms.inbound_sms_filters(["101", "102"]), [
            sms.RC_INBOUND_SMS_FILTER,
            "/restapi/v1.0/account/~/extension/101/message-store/instant?type=SMS",
            "/restapi/v1.0/account/~/extension/102/message-store/instant?type=SMS",
        ])

    def test_only_the_filter_ringcentral_has_is_ever_sent(self):
        # RingCentral's one inbound-text filter is `instant?type=SMS`; pictures
        # come through it as an SMS with an MmsAttachment.
        for filt in sms.inbound_sms_filters(["101", "102"]):
            self.assertTrue(filt.endswith("/message-store/instant?type=SMS"), filt)
            self.assertNotIn("MMS", filt)

    def test_a_malformed_id_is_dropped_rather_than_interpolated(self):
        filters = sms.inbound_sms_filters(["101", "'; DROP--"])
        self.assertEqual(len(filters), 2, "the shared filter plus one recruiter's")
        self.assertFalse(any("DROP" in f for f in filters))


class RegisterSmsWebhookTests(unittest.TestCase):
    def test_the_payload_carries_every_filter_and_the_callback(self):
        ok, client = _run(FakeClient([_response(200, {"id": "sub-1"})]), ["101", "102"])
        self.assertTrue(ok)
        self.assertEqual(len(client.posts), 1)
        payload = client.posts[0]
        self.assertEqual(payload["eventFilters"], sms.inbound_sms_filters(["101", "102"]))
        self.assertEqual(payload["deliveryMode"]["address"], CALLBACK)
        self.assertEqual(payload["deliveryMode"]["transportType"], "WebHook")

    def test_a_malformed_id_never_reaches_ringcentral(self):
        # The CMN-101 cause: refused locally, and the good extension is kept.
        ok, client = _run(FakeClient([_response(200, {"id": "sub-1"})]), ["101", "oops"])
        self.assertTrue(ok)
        sent = client.posts[0]["eventFilters"]
        self.assertFalse(any("oops" in f for f in sent))
        self.assertTrue(any("/extension/101/" in f for f in sent))

    def test_ringcentral_accepts_the_first_request_and_nothing_is_reported(self):
        # The production warning: the first request carried `?type=MMS`, which
        # RingCentral refuses, so every boot fell back and announced that
        # picture messages were lost. One request, every recruiter, no warning.
        with self.assertNoLogs(sms.logger, level="WARNING"):
            ok, client = _run(_refuses_mms_filters(), ["101", "102"])
        self.assertTrue(ok)
        self.assertEqual(len(client.posts), 1)
        self.assertEqual(sms._extensions_in(client.posts[0]["eventFilters"]), {"101", "102"})

    def test_one_unwatchable_extension_does_not_cost_the_others(self):
        # The regression: the old ladder went straight from "everyone" to
        # "nobody", so one unwatchable extension cost every other recruiter.
        ok, client = _run(
            FakeClient([
                _response(400, text="CMN-101"),   # all three
                _response(200, {"id": "sub-3"}),  # first leave-one-out
            ]),
            ["101", "102", "103"],
        )
        self.assertTrue(ok)
        watched = sms._extensions_in(client.posts[-1]["eventFilters"])
        self.assertEqual(len(watched), 2, "exactly one extension was given up")

    def test_a_bad_extension_at_the_FRONT_is_isolated_too(self):
        # Shedding a suffix only rescues the roster when the bad id happens to
        # be last, and reconcile_rc_subscription passes it `sorted()` by id —
        # which says nothing about which one RingCentral refuses. Here 101 is
        # the bad one, so every attempt that still contains it must fail and
        # the ladder must go on to exclude it specifically.
        def answer(n):
            # 1: all three, 2: except 101 → the first that works
            return _response(200, {"id": "sub-9"}) if n >= 2 else _response(400, text="CMN-101")

        class Selective(FakeClient):
            async def post(self, url, json=None, headers=None):
                self.posts.append(json or {})
                return answer(len(self.posts))

        ok, client = _run(Selective([]), ["101", "102", "103"])
        self.assertTrue(ok)
        watched = sms._extensions_in(client.posts[-1]["eventFilters"])
        self.assertEqual(watched, {"102", "103"}, "the bad FIRST extension is the one dropped")

    def test_every_extension_gets_a_turn_at_being_the_excluded_one(self):
        # Whichever single extension is unwatchable, the ladder reaches an
        # attempt that leaves exactly it out.
        ok, client = _run(FakeClient([_response(400, text="CMN-101")] * 20), ["101", "102", "103"])
        self.assertFalse(ok)
        excluded = [
            {"101", "102", "103"} - sms._extensions_in(p["eventFilters"])
            for p in client.posts
            if len(sms._extensions_in(p["eventFilters"])) == 2
        ]
        self.assertEqual(
            sorted(next(iter(e)) for e in excluded), ["101", "102", "103"],
            "each extension is excluded in turn",
        )

    def test_the_shared_number_is_the_last_resort_never_the_first(self):
        # An account-admin refusal fails EVERY attempt that names another
        # extension: all of them, then each leave-one-out.
        ok, client = _run(
            FakeClient([_response(403, text="admin required")] * 3 + [_response(200, {"id": "sub-4"})]),
            ["101", "102"],
        )
        self.assertTrue(ok)
        self.assertEqual(len(client.posts), 4)
        final = client.posts[-1]["eventFilters"]
        self.assertEqual(sms._extensions_in(final), set(), "no recruiter extension survives")
        self.assertEqual(final, [sms.RC_INBOUND_SMS_FILTER])

    def test_it_reports_which_recruiters_were_lost(self):
        # All, then "except 101" refused; "except 102" works, so 102 is lost.
        with self.assertLogs(sms.logger, level="WARNING") as captured:
            _run(
                FakeClient([
                    _response(400, text="CMN-101"),
                    _response(400, text="CMN-101"),
                    _response(200, {"id": "sub-5"}),
                ]),
                ["101", "102"],
            )
        joined = "\n".join(captured.output)
        self.assertIn("Extension(s) 102 are NOT watched", joined, "the dropped extension is named")
        self.assertIn("will not reach Telegram", joined, "and the consequence is stated")

    def test_an_empty_roster_has_nothing_smaller_to_ask_for(self):
        # The shared filter alone IS the request that failed, so there is no
        # fallback: the caller retries on its next tick.
        ok, client = _run(FakeClient([_response(503, text="try later")] * 3), [])
        self.assertFalse(ok)
        self.assertEqual(len(client.posts), 1)

    def test_the_filters_are_logged_so_a_bad_id_is_diagnosable(self):
        with self.assertLogs(sms.logger, level="WARNING") as captured:
            _run(
                FakeClient([_response(400, text="CMN-101"), _response(200, {"id": "sub-7"})]),
                ["101"],
            )
        joined = "\n".join(captured.output)
        self.assertIn("/extension/101/message-store", joined)

    def test_total_failure_returns_false_for_the_caller_to_retry(self):
        ok, client = _run(
            FakeClient([_response(500, text="boom")] * 6),
            ["101", "102"],
        )
        self.assertFalse(ok, "reconcile_rc_subscription retries on False")

    def test_an_existing_matching_subscription_is_left_alone(self):
        # Exactly what this code registers today: before the MMS filter went,
        # this never matched, so every registration deleted it and made anew.
        existing = _response(200, {"records": [{
            "id": "sub-old",
            "status": "Active",
            "deliveryMode": {"address": CALLBACK},
            "eventFilters": sms.inbound_sms_filters(["101"]),
        }]})
        ok, client = _run(FakeClient([], get_response=existing), ["101"])
        self.assertTrue(ok)
        self.assertEqual(client.posts, [], "nothing is re-registered")
        self.assertEqual(client.deletes, [], "and nothing is deleted")

    def test_a_subscription_ringcentral_stopped_delivering_is_replaced(self):
        # Right filters, but blacklisted: keeping it would watch nothing.
        existing = _response(200, {"records": [{
            "id": "sub-dead",
            "status": "Blacklisted",
            "deliveryMode": {"address": CALLBACK},
            "eventFilters": sms.inbound_sms_filters(["101"]),
        }]})
        ok, client = _run(FakeClient([_response(200, {"id": "sub-new"})], get_response=existing), ["101"])
        self.assertTrue(ok)
        self.assertEqual(len(client.deletes), 1)
        self.assertTrue(client.deletes[0].endswith("/subscription/sub-dead"))
        self.assertEqual(client.posts[0]["eventFilters"], sms.inbound_sms_filters(["101"]))

    def test_a_subscription_missing_a_new_recruiter_is_replaced(self):
        existing = _response(200, {"records": [{
            "id": "sub-old",
            "status": "Active",
            "deliveryMode": {"address": CALLBACK},
            "eventFilters": sms.inbound_sms_filters(["101"]),
        }]})
        ok, client = _run(FakeClient([_response(200, {"id": "sub-new"})], get_response=existing), ["101", "102"])
        self.assertTrue(ok)
        self.assertEqual(len(client.deletes), 1)
        self.assertEqual(sms._extensions_in(client.posts[0]["eventFilters"]), {"101", "102"})

    def test_a_subscription_for_another_address_is_not_touched(self):
        existing = _response(200, {"records": [{
            "id": "sub-other",
            "status": "Active",
            "deliveryMode": {"address": "https://someone-else.test/hook"},
            "eventFilters": [sms.RC_INBOUND_SMS_FILTER],
        }]})
        ok, client = _run(FakeClient([_response(200, {"id": "sub-new"})], get_response=existing), [])
        self.assertTrue(ok)
        self.assertEqual(client.deletes, [])
        self.assertEqual(len(client.posts), 1)

    def test_it_never_raises_when_ringcentral_is_unreachable(self):
        class Exploding(FakeClient):
            async def get(self, url, headers=None):
                raise RuntimeError("connection reset")

        ok, _client = _run(Exploding([]), ["101"])
        self.assertFalse(ok, "a failure is reported, not thrown")


class ExtensionsInTests(unittest.TestCase):
    def test_it_reads_extension_ids_back_out_of_filters(self):
        self.assertEqual(sms._extensions_in(sms.inbound_sms_filters(["101", "102"])), {"101", "102"})

    def test_the_shared_extension_is_not_an_extension_id(self):
        self.assertEqual(sms._extensions_in([sms.RC_INBOUND_SMS_FILTER]), set())

    def test_junk_does_not_throw(self):
        self.assertEqual(sms._extensions_in([None, "", "not a filter"]), set())


if __name__ == "__main__":
    unittest.main()
