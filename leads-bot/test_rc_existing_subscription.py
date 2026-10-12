"""What is already registered at our address — kept, or replaced, and when.

Before the MMS filter went, no existing subscription ever matched what was
wanted, so every registration deleted the working one first and then asked for
a new one. Now one can be kept, so these pin when it may be: only while
RingCentral reports it Active, since a suspended or blacklisted webhook has the
right filters and delivers nothing. And a replacement is made BEFORE the old
one is deleted: deleting first left nothing watching whenever RingCentral then
refused or failed the new request.

subscription_active() is the status read the reconciler makes on every tick
whose roster has not changed.
"""
import asyncio
import unittest
from unittest.mock import patch

from rc_fakes import (
    CALLBACK,
    FakeClient,
    listing as _listing,
    ours as _ours,
    patched as _patched,
    response as _response,
    run as _run,
)
import rc_inbound_subscription as rcin


class ExistingSubscriptionTests(unittest.TestCase):
    """What is already registered at our address: kept, or replaced — and when."""

    def test_an_existing_matching_subscription_is_left_alone(self):
        # Exactly what this code registers today: before the MMS filter went,
        # this never matched, so every registration deleted it and made anew.
        ok, client = _run(FakeClient([], get_response=_listing(_ours("sub-old"))), ["101"])
        self.assertTrue(ok)
        self.assertEqual(client.posts, [], "nothing is re-registered")
        self.assertEqual(client.deletes, [], "and nothing is deleted")

    def test_a_duplicate_beside_the_one_kept_is_removed(self):
        # Two at one address deliver every message twice.
        listing = _listing(_ours("sub-dup", status="Suspended"), _ours("sub-old"))
        ok, client = _run(FakeClient([], get_response=listing), ["101"])
        self.assertTrue(ok)
        self.assertEqual(client.posts, [])
        self.assertEqual([url.rsplit("/", 1)[-1] for url in client.deletes], ["sub-dup"])

    def test_a_subscription_ringcentral_stopped_delivering_is_replaced(self):
        # Right filters, but blacklisted: keeping it would watch nothing.
        listing = _listing(_ours("sub-dead", status="Blacklisted"))
        ok, client = _run(FakeClient([_response(200, {"id": "sub-new"})], get_response=listing), ["101"])
        self.assertTrue(ok)
        self.assertEqual(len(client.deletes), 1)
        self.assertTrue(client.deletes[0].endswith("/subscription/sub-dead"))
        self.assertEqual(client.posts[0]["eventFilters"], rcin.inbound_sms_filters(["101"]))

    def test_a_subscription_missing_a_new_recruiter_is_replaced(self):
        ok, client = _run(
            FakeClient([_response(200, {"id": "sub-new"})], get_response=_listing(_ours("sub-old"))),
            ["101", "102"],
        )
        self.assertTrue(ok)
        self.assertEqual(len(client.deletes), 1)
        self.assertEqual(rcin._extensions_in(client.posts[0]["eventFilters"]), {"101", "102"})

    def test_the_old_one_is_deleted_only_after_its_successor_exists(self):
        # Deleting first left nothing watching while RingCentral refused or
        # failed the new request.
        ok, client = _run(
            FakeClient([_response(200, {"id": "sub-new"})], get_response=_listing(_ours("sub-old"))),
            ["101", "102"],
        )
        self.assertTrue(ok)
        self.assertEqual(client.calls, ["post", "delete"])

    def test_a_failed_registration_leaves_the_old_one_delivering(self):
        # It still watches 101; with no successor, deleting it would watch nobody.
        for answer in (_response(503), _response(400, text="CMN-101")):
            with self.subTest(status=answer.status_code):
                ok, client = _run(
                    FakeClient([answer] * 4, get_response=_listing(_ours("sub-old"))),
                    ["101", "102"],
                )
                self.assertFalse(ok)
                self.assertEqual(client.deletes, [])

    def test_a_fallback_that_works_replaces_the_old_one(self):
        ok, client = _run(
            FakeClient(
                [_response(403, text="admin required"), _response(200, {"id": "sub-new"})],
                get_response=_listing(_ours("sub-old", status="Blacklisted")),
            ),
            ["101", "102"],
        )
        self.assertTrue(ok)
        self.assertEqual(client.calls, ["post", "post", "delete"])

    def test_a_subscription_for_another_address_is_not_touched(self):
        existing = _response(200, {"records": [{
            "id": "sub-other",
            "status": "Active",
            "deliveryMode": {"address": "https://someone-else.test/hook"},
            "eventFilters": [rcin.RC_INBOUND_SMS_FILTER],
        }]})
        ok, client = _run(FakeClient([_response(200, {"id": "sub-new"})], get_response=existing), [])
        self.assertTrue(ok)
        self.assertEqual(client.deletes, [])
        self.assertEqual(len(client.posts), 1)


class SubscriptionActiveTests(unittest.TestCase):
    """The status read the reconciler makes when the roster has not changed."""

    def _check(self, get_response):
        return _patched(FakeClient([], get_response=get_response), lambda: rcin.subscription_active(CALLBACK))

    def test_an_active_subscription_at_our_address_is_delivering(self):
        self.assertIs(self._check(_listing(_ours("sub-1"))), True)

    def test_a_blacklisted_or_suspended_one_is_not(self):
        listing = _listing(_ours("sub-1", status="Blacklisted"), _ours("sub-2", status="Suspended"))
        self.assertIs(self._check(listing), False)

    def test_none_at_our_address_is_not(self):
        elsewhere = {**_ours("sub-1"), "deliveryMode": {"address": "https://someone-else.test/hook"}}
        self.assertIs(self._check(_listing(elsewhere)), False)

    def test_an_unreadable_listing_is_evidence_of_nothing(self):
        self.assertIsNone(self._check(_response(503)))

    def test_without_credentials_it_cannot_tell(self):
        with patch.object(rcin, "RC_JWT_TOKEN", ""):
            self.assertIsNone(asyncio.run(rcin.subscription_active(CALLBACK)))

    def test_it_never_raises(self):
        class Exploding(FakeClient):
            async def get(self, url, headers=None):
                raise RuntimeError("connection reset")

        self.assertIsNone(_patched(Exploding([]), lambda: rcin.subscription_active(CALLBACK)))


if __name__ == "__main__":
    unittest.main()
