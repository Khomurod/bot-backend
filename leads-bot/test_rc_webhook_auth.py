"""/rc-webhook only acts on notifications from OUR RingCentral subscription.

The route is public, and before this a POST with `direction: Inbound` and an
SMS type was forwarded to the leads Telegram group and offered to the
after-hours reply, whoever sent it (November 2026, found in review). RingCentral
echoes the subscription's `verificationToken` in a `Verification-Token` header
on every notification; these tests pin that the token is on every subscription
we create, that the first pass of a process puts it there, and that the route
refuses what does not carry it — without dropping anything real while an older
subscription may still be the live one.
"""
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "test-telegram-token")
os.environ.setdefault("TELEGRAM_CHAT_ID", "-1001234567890")
os.environ.setdefault("WEBHOOK_VERIFY_TOKEN", "test-verify")
os.environ.setdefault("META_APP_SECRET", "test-meta-secret")
os.environ.setdefault("LEADS_INTERNAL_SHARED_SECRET", "test-internal-secret")

from fastapi.testclient import TestClient  # noqa: E402

import rc_inbound_subscription as rcin  # noqa: E402
import rc_webhook_auth as auth  # noqa: E402
import webhook_server as wh  # noqa: E402
from rc_fakes import CALLBACK, FakeClient, listing, ours, patched, response  # noqa: E402
from webhook import rc_subscription as rcs  # noqa: E402

INBOUND = {"body": {"direction": "Inbound", "type": "SMS", "from": {"phoneNumber": "+15550100001"}, "subject": "hi"}}


class TokenTests(unittest.TestCase):
    def test_the_token_is_derived_from_the_secret_and_stable(self):
        one = auth.verification_token("secret-a")
        self.assertEqual(one, auth.verification_token("secret-a"))
        self.assertRegex(one, r"^[0-9a-f]{32}$")
        self.assertNotEqual(one, auth.verification_token("secret-b"))
        self.assertNotIn("secret-a", one)

    def test_no_secret_no_token(self):
        self.assertIsNone(auth.verification_token(""))


class VerdictTests(unittest.TestCase):
    T = "0123456789abcdef0123456789abcdef"

    def test_the_right_token_is_accepted(self):
        self.assertEqual(auth.verdict(self.T, expected=self.T, armed=True), auth.ACCEPT)
        self.assertEqual(auth.verdict(f" {self.T} ", expected=self.T, armed=False), auth.ACCEPT)

    def test_a_wrong_token_is_refused_once_armed(self):
        self.assertEqual(auth.verdict("nope", expected=self.T, armed=True), auth.REJECT)
        self.assertEqual(auth.verdict("ünïcode", expected=self.T, armed=True), auth.REJECT)

    def test_before_arming_an_old_token_still_gets_through(self):
        # The live subscription may carry the token of a secret since changed.
        self.assertEqual(auth.verdict("old-token", expected=self.T, armed=False), auth.ACCEPT_UNVERIFIED)

    def test_no_token_is_refused_once_armed_and_let_through_before(self):
        self.assertEqual(auth.verdict(None, expected=self.T, armed=True), auth.REJECT)
        self.assertEqual(auth.verdict("", expected=self.T, armed=True), auth.REJECT)
        self.assertEqual(auth.verdict(None, expected=self.T, armed=False), auth.ACCEPT_UNVERIFIED)

    def test_nothing_to_check_against_fails_closed(self):
        for armed in (False, True):
            self.assertEqual(auth.verdict(None, expected=None, armed=armed), auth.REJECT)
            self.assertEqual(auth.verdict("anything", expected=None, armed=armed), auth.REJECT)


class RegistrationCarriesTheTokenTests(unittest.TestCase):
    def test_every_subscription_created_carries_it(self):
        client = FakeClient([response(200, {"id": "sub-new"})])
        self.assertTrue(patched(client, lambda: rcin.register_sms_webhook(CALLBACK, ["101"])))
        delivery = client.posts[0]["deliveryMode"]
        self.assertEqual(delivery["verificationToken"], auth.verification_token())
        self.assertEqual(delivery["address"], CALLBACK)

    def test_a_fallback_carries_it_too(self):
        client = FakeClient([response(400, text="CMN-101"), response(200, {"id": "sub-shared"})])
        self.assertTrue(patched(client, lambda: rcin.register_sms_webhook(CALLBACK, ["101"])))
        self.assertEqual(len(client.posts), 2)
        for post in client.posts:
            self.assertEqual(post["deliveryMode"]["verificationToken"], auth.verification_token())

    def test_fresh_replaces_a_matching_active_subscription_successor_first(self):
        client = FakeClient([response(200, {"id": "sub-new"})], get_response=listing(ours("sub-old")))
        self.assertTrue(patched(client, lambda: rcin.register_sms_webhook(CALLBACK, ["101"], fresh=True)))
        self.assertEqual(client.calls, ["post", "delete"])
        self.assertTrue(client.deletes[0].endswith("/sub-old"))

    def test_a_refused_fresh_registration_keeps_what_already_covers_everyone(self):
        # The full roster is refused; shedding a recruiter and then deleting a
        # subscription that covers them all would lose that recruiter for nothing.
        client = FakeClient(
            [response(400, text="CMN-101"), response(200, {"id": "sub-narrow"})],
            get_response=listing(ours("sub-old", extensions=("101", "102"))),
        )
        self.assertFalse(patched(client, lambda: rcin.register_sms_webhook(CALLBACK, ["101", "102"], fresh=True)))
        self.assertEqual(len(client.posts), 1)
        self.assertEqual(client.deletes, [])

    def test_a_refused_fresh_registration_with_nothing_covering_still_sheds(self):
        # Nothing to keep: the ladder still saves what it can, as before.
        client = FakeClient([response(400, text="CMN-101"), response(200, {"id": "sub-narrow"})])
        self.assertTrue(patched(client, lambda: rcin.register_sms_webhook(CALLBACK, ["101", "102"], fresh=True)))
        self.assertEqual(len(client.posts), 2)

    def test_without_a_secret_nothing_is_registered(self):
        client = FakeClient([response(200, {"id": "sub-new"})])
        with patch.object(rcin, "verification_token", return_value=None):
            self.assertFalse(patched(client, lambda: rcin.register_sms_webhook(CALLBACK, ["101"], fresh=True)))
        self.assertEqual(client.posts, [])

    def test_without_fresh_a_matching_active_subscription_is_kept(self):
        client = FakeClient([], get_response=listing(ours("sub-old")))
        self.assertTrue(patched(client, lambda: rcin.register_sms_webhook(CALLBACK, ["101"])))
        self.assertEqual(client.posts, [])


class ArmingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        rcs._reset_state_for_tests()
        auth._reset_for_tests()
        self.addCleanup(auth._reset_for_tests)
        roster = patch.object(rcs, "_fetch_ringcentral_sms_extensions", new_callable=AsyncMock, return_value=["101"])
        roster.start()
        self.addCleanup(roster.stop)
        status = patch.object(rcs, "subscription_active", new_callable=AsyncMock, return_value=True)
        status.start()
        self.addCleanup(status.stop)

    async def test_a_registered_first_pass_arms_the_check(self):
        with patch.object(rcs, "register_sms_webhook", new_callable=AsyncMock, return_value=True):
            await rcs.reconcile_rc_subscription(CALLBACK)
        self.assertTrue(auth.is_armed())

    async def test_a_failed_first_pass_does_not_and_is_retried_afresh(self):
        with patch.object(rcs, "register_sms_webhook", new_callable=AsyncMock, side_effect=[False, True]) as register:
            await rcs.reconcile_rc_subscription(CALLBACK)
            self.assertFalse(auth.is_armed())
            await rcs.reconcile_rc_subscription(CALLBACK)
        self.assertTrue(auth.is_armed())
        self.assertEqual(register.await_args_list[1].kwargs, {"fresh": True})

    async def test_an_unknown_roster_is_never_registered_afresh(self):
        # The first read fails: keep what covers every recruiter, do not arm.
        with patch.object(rcs, "_fetch_ringcentral_sms_extensions", new_callable=AsyncMock, side_effect=RuntimeError("hub down")):
            with patch.object(rcs, "register_sms_webhook", new_callable=AsyncMock, return_value=True) as register:
                await rcs.reconcile_rc_subscription(CALLBACK)
        self.assertEqual(register.await_args.kwargs, {})
        self.assertFalse(auth.is_armed())
        # The next read works — even an unchanged (empty) roster — so it is
        # registered afresh from what is now known, and the check arms.
        with patch.object(rcs, "_fetch_ringcentral_sms_extensions", new_callable=AsyncMock, return_value=[]):
            with patch.object(rcs, "register_sms_webhook", new_callable=AsyncMock, return_value=True) as register:
                await rcs.reconcile_rc_subscription(CALLBACK)
        self.assertEqual(register.await_args.kwargs, {"fresh": True})
        self.assertTrue(auth.is_armed())

    async def test_later_passes_are_not_fresh(self):
        with patch.object(rcs, "register_sms_webhook", new_callable=AsyncMock, return_value=True) as register:
            await rcs.reconcile_rc_subscription(CALLBACK)
            with patch.object(rcs, "_fetch_ringcentral_sms_extensions", new_callable=AsyncMock, return_value=["101", "102"]):
                await rcs.reconcile_rc_subscription(CALLBACK)
        self.assertEqual(register.await_args_list[1].kwargs, {})


class RouteTests(unittest.TestCase):
    def setUp(self):
        auth._reset_for_tests()
        self.addCleanup(auth._reset_for_tests)
        forward = patch.object(wh, "_forward_ringcentral_inbound_to_telegram", new_callable=AsyncMock)
        self.forward = forward.start()
        self.addCleanup(forward.stop)
        # No `with`: the app's startup (RingCentral registration, the /connect
        # poller) must not run in a unit test.
        self.client = TestClient(wh.app)

    def post(self, token=None):
        headers = {"Verification-Token": token} if token is not None else {}
        return self.client.post("/rc-webhook", json=INBOUND, headers=headers)

    def test_once_armed_a_forged_notification_is_refused_and_goes_nowhere(self):
        auth.arm()
        self.assertEqual(self.post().status_code, 403)
        self.assertEqual(self.post("guessed").status_code, 403)
        self.forward.assert_not_awaited()

    def test_ringcentral_with_the_token_is_forwarded(self):
        auth.arm()
        self.assertEqual(self.post(auth.verification_token()).status_code, 200)
        self.forward.assert_awaited_once()

    def test_before_arming_the_old_subscription_still_gets_through(self):
        self.assertEqual(self.post().status_code, 200)
        self.forward.assert_awaited_once()

    def test_before_arming_a_subscription_with_an_old_token_still_gets_through(self):
        self.assertEqual(self.post("token-of-a-secret-since-changed").status_code, 200)
        self.forward.assert_awaited_once()

    def test_without_a_secret_everything_is_refused(self):
        with patch.object(auth, "verification_token", return_value=None):
            self.assertEqual(self.post().status_code, 403)
            self.assertEqual(self.post("anything").status_code, 403)
        self.forward.assert_not_awaited()

    def test_the_validation_handshake_still_answers(self):
        auth.arm()
        resp = self.client.post("/rc-webhook", headers={"Validation-Token": "abc"})
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers.get("Validation-Token"), "abc")


if __name__ == "__main__":
    unittest.main()
