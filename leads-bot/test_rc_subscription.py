"""The inbound-SMS subscription keeps up with the recruiter roster.

A recruiter can finish RingCentral onboarding at any time. Until their
extension is in the subscription, the SMS they send works and the driver's
reply reaches nobody — so registering once at startup leaves a hole that only
a restart closes. These tests pin the reconcile behaviour, and especially the
two ways it must NOT behave: re-registering on every tick, and treating a
failed read of the roster as "no recruiters". And one thing it must do: notice
when RingCentral stops delivering the subscription of an unchanged roster —
it blacklists a webhook whose address stopped answering, and the roster says
nothing about that.
"""
import asyncio
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "test-telegram-token")
os.environ.setdefault("TELEGRAM_CHAT_ID", "-1001234567890")
os.environ.setdefault("WEBHOOK_VERIFY_TOKEN", "test-verify")
os.environ.setdefault("META_APP_SECRET", "test-meta-secret")
os.environ.setdefault("LEADS_INTERNAL_SHARED_SECRET", "test-internal-secret")

from webhook import rc_subscription as rcs

CALLBACK = "https://app.test/rc-webhook"


class TestReconcileRcSubscription(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        rcs._reset_state_for_tests()
        # RingCentral says the subscription is delivering unless a test says not.
        status = patch.object(rcs, "subscription_active", new_callable=AsyncMock, return_value=True)
        self.status = status.start()
        self.addCleanup(status.stop)

    async def test_first_pass_registers(self):
        with patch.object(rcs, "_fetch_ringcentral_sms_extensions", new_callable=AsyncMock, return_value=["101"]):
            with patch.object(rcs, "register_sms_webhook", new_callable=AsyncMock, return_value=True) as register:
                self.assertTrue(await rcs.reconcile_rc_subscription(CALLBACK))
                register.assert_awaited_once_with(CALLBACK, ["101"])

    async def test_unchanged_roster_does_not_re_register(self):
        with patch.object(rcs, "_fetch_ringcentral_sms_extensions", new_callable=AsyncMock, return_value=["101"]):
            with patch.object(rcs, "register_sms_webhook", new_callable=AsyncMock, return_value=True) as register:
                await rcs.reconcile_rc_subscription(CALLBACK)
                # Steady state: one internal read and one status read per tick.
                self.assertFalse(await rcs.reconcile_rc_subscription(CALLBACK))
                self.assertFalse(await rcs.reconcile_rc_subscription(CALLBACK))
                self.assertEqual(register.await_count, 1)
                self.assertEqual(self.status.await_count, 2)
                self.status.assert_awaited_with(CALLBACK)

    async def test_a_newly_onboarded_recruiter_is_picked_up(self):
        rosters = [["101"], ["101", "102"]]
        with patch.object(
            rcs, "_fetch_ringcentral_sms_extensions", new_callable=AsyncMock, side_effect=rosters
        ):
            with patch.object(rcs, "register_sms_webhook", new_callable=AsyncMock, return_value=True) as register:
                await rcs.reconcile_rc_subscription(CALLBACK)
                self.assertTrue(await rcs.reconcile_rc_subscription(CALLBACK))
                self.assertEqual(register.await_args.args, (CALLBACK, ["101", "102"]))

    async def test_order_of_the_roster_is_not_a_change(self):
        rosters = [["101", "102"], ["102", "101"]]
        with patch.object(
            rcs, "_fetch_ringcentral_sms_extensions", new_callable=AsyncMock, side_effect=rosters
        ):
            with patch.object(rcs, "register_sms_webhook", new_callable=AsyncMock, return_value=True) as register:
                await rcs.reconcile_rc_subscription(CALLBACK)
                self.assertFalse(await rcs.reconcile_rc_subscription(CALLBACK))
                self.assertEqual(register.await_count, 1)

    async def test_a_removed_recruiter_is_a_change(self):
        rosters = [["101", "102"], ["101"]]
        with patch.object(
            rcs, "_fetch_ringcentral_sms_extensions", new_callable=AsyncMock, side_effect=rosters
        ):
            with patch.object(rcs, "register_sms_webhook", new_callable=AsyncMock, return_value=True) as register:
                await rcs.reconcile_rc_subscription(CALLBACK)
                self.assertTrue(await rcs.reconcile_rc_subscription(CALLBACK))
                self.assertEqual(register.await_args.args, (CALLBACK, ["101"]))

    async def test_a_failed_read_after_the_first_pass_leaves_the_subscription_alone(self):
        # THE DANGEROUS CASE: an unreachable hub must not be read as "nobody has
        # credentials", which would re-register without any recruiter extension
        # and silently drop every recruiter's inbound SMS.
        with patch.object(
            rcs,
            "_fetch_ringcentral_sms_extensions",
            new_callable=AsyncMock,
            side_effect=[["101"], RuntimeError("hub unreachable")],
        ):
            with patch.object(rcs, "register_sms_webhook", new_callable=AsyncMock, return_value=True) as register:
                await rcs.reconcile_rc_subscription(CALLBACK)
                self.assertFalse(await rcs.reconcile_rc_subscription(CALLBACK))
                self.assertEqual(register.await_count, 1)
                self.assertEqual(register.await_args.args, (CALLBACK, ["101"]))

    async def test_a_failed_read_on_the_FIRST_pass_still_watches_the_shared_number(self):
        with patch.object(
            rcs, "_fetch_ringcentral_sms_extensions", new_callable=AsyncMock, side_effect=RuntimeError("hub down")
        ):
            with patch.object(rcs, "register_sms_webhook", new_callable=AsyncMock, return_value=True) as register:
                self.assertTrue(await rcs.reconcile_rc_subscription(CALLBACK))
                register.assert_awaited_once_with(CALLBACK, [])

    async def test_a_failed_registration_is_retried_next_tick(self):
        with patch.object(rcs, "_fetch_ringcentral_sms_extensions", new_callable=AsyncMock, return_value=["101"]):
            with patch.object(
                rcs, "register_sms_webhook", new_callable=AsyncMock, side_effect=[False, True]
            ) as register:
                self.assertFalse(await rcs.reconcile_rc_subscription(CALLBACK))
                # Not recorded as live, so the next tick tries again.
                self.assertTrue(await rcs.reconcile_rc_subscription(CALLBACK))
                self.assertEqual(register.await_count, 2)

    async def test_a_subscription_ringcentral_stopped_delivering_is_registered_again(self):
        with patch.object(rcs, "_fetch_ringcentral_sms_extensions", new_callable=AsyncMock, return_value=["101"]):
            with patch.object(rcs, "register_sms_webhook", new_callable=AsyncMock, return_value=True) as register:
                await rcs.reconcile_rc_subscription(CALLBACK)
                self.status.return_value = False  # blacklisted after a failed delivery
                self.assertTrue(await rcs.reconcile_rc_subscription(CALLBACK))
                self.assertEqual(register.await_count, 2)
                self.assertEqual(register.await_args.args, (CALLBACK, ["101"]))

    async def test_an_unreadable_status_is_not_a_reason_to_re_register(self):
        with patch.object(rcs, "_fetch_ringcentral_sms_extensions", new_callable=AsyncMock, return_value=["101"]):
            with patch.object(rcs, "register_sms_webhook", new_callable=AsyncMock, return_value=True) as register:
                await rcs.reconcile_rc_subscription(CALLBACK)
                self.status.return_value = None  # RingCentral did not answer
                self.assertFalse(await rcs.reconcile_rc_subscription(CALLBACK))
                self.assertEqual(register.await_count, 1)

    async def test_a_failed_re_registration_is_tried_again_next_tick(self):
        with patch.object(rcs, "_fetch_ringcentral_sms_extensions", new_callable=AsyncMock, return_value=["101"]):
            with patch.object(
                rcs, "register_sms_webhook", new_callable=AsyncMock, side_effect=[True, False, True]
            ) as register:
                await rcs.reconcile_rc_subscription(CALLBACK)
                self.status.return_value = False
                self.assertFalse(await rcs.reconcile_rc_subscription(CALLBACK))
                self.assertTrue(await rcs.reconcile_rc_subscription(CALLBACK))
                self.assertEqual(register.await_count, 3)

    async def test_the_first_pass_does_not_wait_for_a_status_read(self):
        with patch.object(rcs, "_fetch_ringcentral_sms_extensions", new_callable=AsyncMock, return_value=["101"]):
            with patch.object(rcs, "register_sms_webhook", new_callable=AsyncMock, return_value=True):
                await rcs.reconcile_rc_subscription(CALLBACK)
                self.status.assert_not_awaited()


class TestRefresherLifecycle(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        rcs._reset_state_for_tests()

    async def test_it_registers_at_boot_and_stops_cleanly(self):
        with patch.object(rcs, "STARTUP_DELAY_SECONDS", 0):
            with patch.object(rcs, "reconcile_rc_subscription", new_callable=AsyncMock, return_value=True) as reconcile:
                rcs.start_rc_subscription_refresher(CALLBACK)
                await asyncio.sleep(0.05)
                reconcile.assert_awaited_with(CALLBACK)
                await rcs.stop_rc_subscription_refresher()
                self.assertIsNone(rcs._task)

    async def test_starting_twice_does_not_run_two_loops(self):
        with patch.object(rcs, "STARTUP_DELAY_SECONDS", 0):
            with patch.object(rcs, "reconcile_rc_subscription", new_callable=AsyncMock, return_value=True) as reconcile:
                rcs.start_rc_subscription_refresher(CALLBACK)
                rcs.start_rc_subscription_refresher(CALLBACK)
                await asyncio.sleep(0.05)
                self.assertEqual(reconcile.await_count, 1)
                await rcs.stop_rc_subscription_refresher()

    async def test_one_bad_tick_does_not_end_the_loop(self):
        with patch.object(rcs, "STARTUP_DELAY_SECONDS", 0):
            with patch.object(rcs, "RC_SUBSCRIPTION_REFRESH_SECONDS", 0):
                with patch.object(
                    rcs,
                    "reconcile_rc_subscription",
                    new_callable=AsyncMock,
                    side_effect=[RuntimeError("boom"), True, True, True, True, True, True, True],
                ) as reconcile:
                    rcs.start_rc_subscription_refresher(CALLBACK)
                    await asyncio.sleep(0.05)
                    await rcs.stop_rc_subscription_refresher()
                    self.assertGreater(reconcile.await_count, 1)

    async def test_stopping_without_starting_is_safe(self):
        await rcs.stop_rc_subscription_refresher()


if __name__ == "__main__":
    unittest.main()
