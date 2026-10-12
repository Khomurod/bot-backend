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
import unittest

from rc_fakes import CALLBACK, FakeClient, response as _response, run as _run
import rc_inbound_subscription as rcin


class ValidExtensionIdsTests(unittest.TestCase):
    def test_keeps_numeric_ids_in_order_without_duplicates(self):
        usable, rejected = rcin.valid_extension_ids(["101", "102", "101", " 103 "])
        self.assertEqual(usable, ["101", "102", "103"])
        self.assertEqual(rejected, [])

    def test_refuses_anything_that_is_not_a_number(self):
        # A non-numeric id interpolated into a filter path invalidates the WHOLE
        # subscription, so it must never reach RingCentral.
        usable, rejected = rcin.valid_extension_ids(["101", "not-an-id", "", None, "8005551212"])
        self.assertEqual(usable, ["101", "8005551212"])
        self.assertEqual(rejected, ["not-an-id"])

    def test_the_shared_extension_is_never_an_extra(self):
        usable, rejected = rcin.valid_extension_ids(["~", "101"])
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
        self.assertEqual(rcin.inbound_sms_filters([]), [rcin.RC_INBOUND_SMS_FILTER])

    def test_each_recruiter_extension_gets_one_filter(self):
        self.assertEqual(rcin.inbound_sms_filters(["101", "102"]), [
            rcin.RC_INBOUND_SMS_FILTER,
            "/restapi/v1.0/account/~/extension/101/message-store/instant?type=SMS",
            "/restapi/v1.0/account/~/extension/102/message-store/instant?type=SMS",
        ])

    def test_only_the_filter_ringcentral_has_is_ever_sent(self):
        # RingCentral's one inbound-text filter is `instant?type=SMS`; pictures
        # come through it as an SMS with an MmsAttachment.
        for filt in rcin.inbound_sms_filters(["101", "102"]):
            self.assertTrue(filt.endswith("/message-store/instant?type=SMS"), filt)
            self.assertNotIn("MMS", filt)

    def test_a_malformed_id_is_dropped_rather_than_interpolated(self):
        filters = rcin.inbound_sms_filters(["101", "'; DROP--"])
        self.assertEqual(len(filters), 2, "the shared filter plus one recruiter's")
        self.assertFalse(any("DROP" in f for f in filters))


class RegisterSmsWebhookTests(unittest.TestCase):
    def test_the_payload_carries_every_filter_and_the_callback(self):
        ok, client = _run(FakeClient([_response(200, {"id": "sub-1"})]), ["101", "102"])
        self.assertTrue(ok)
        self.assertEqual(len(client.posts), 1)
        payload = client.posts[0]
        self.assertEqual(payload["eventFilters"], rcin.inbound_sms_filters(["101", "102"]))
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
        with self.assertNoLogs(rcin.logger, level="WARNING"):
            ok, client = _run(_refuses_mms_filters(), ["101", "102"])
        self.assertTrue(ok)
        self.assertEqual(len(client.posts), 1)
        self.assertEqual(rcin._extensions_in(client.posts[0]["eventFilters"]), {"101", "102"})

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
        watched = rcin._extensions_in(client.posts[-1]["eventFilters"])
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
        watched = rcin._extensions_in(client.posts[-1]["eventFilters"])
        self.assertEqual(watched, {"102", "103"}, "the bad FIRST extension is the one dropped")

    def test_every_extension_gets_a_turn_at_being_the_excluded_one(self):
        # Whichever single extension is unwatchable, the ladder reaches an
        # attempt that leaves exactly it out.
        ok, client = _run(FakeClient([_response(400, text="CMN-101")] * 20), ["101", "102", "103"])
        self.assertFalse(ok)
        excluded = [
            {"101", "102", "103"} - rcin._extensions_in(p["eventFilters"])
            for p in client.posts
            if len(rcin._extensions_in(p["eventFilters"])) == 2
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
        self.assertEqual(rcin._extensions_in(final), set(), "no recruiter extension survives")
        self.assertEqual(final, [rcin.RC_INBOUND_SMS_FILTER])

    def test_it_reports_which_recruiters_were_lost(self):
        # All, then "except 101" refused; "except 102" works, so 102 is lost.
        with self.assertLogs(rcin.logger, level="WARNING") as captured:
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
        ok, client = _run(FakeClient([_response(400, text="CMN-101")] * 3), [])
        self.assertFalse(ok)
        self.assertEqual(len(client.posts), 1)

    def test_ringcentral_being_unavailable_never_costs_a_recruiter(self):
        # A 503 says nothing about the filters. Shedding a recruiter for it,
        # then succeeding, would be recorded as the whole roster, and that
        # recruiter would stay unwatched until the roster next changed.
        for status in (408, 429, 500, 503):
            with self.subTest(status=status):
                ok, client = _run(FakeClient([_response(status), _response(200, {"id": "sub-x"})]), ["101", "102"])
                self.assertFalse(ok, "the caller retries the whole roster next pass")
                self.assertEqual(len(client.posts), 1, "no smaller request is tried")

    def test_ringcentral_failing_part_way_down_the_ladder_stops_it(self):
        # 101 is refused for real, then RingCentral fails: nothing more is shed.
        ok, client = _run(
            FakeClient([_response(403, text="admin required"), _response(503), _response(200, {"id": "sub-x"})]),
            ["101", "102"],
        )
        self.assertFalse(ok)
        self.assertEqual(len(client.posts), 2)

    def test_the_filters_are_logged_so_a_bad_id_is_diagnosable(self):
        with self.assertLogs(rcin.logger, level="WARNING") as captured:
            _run(
                FakeClient([_response(400, text="CMN-101"), _response(200, {"id": "sub-7"})]),
                ["101"],
            )
        joined = "\n".join(captured.output)
        self.assertIn("/extension/101/message-store", joined)

    def test_total_failure_returns_false_for_the_caller_to_retry(self):
        ok, client = _run(
            FakeClient([_response(400, text="CMN-101")] * 6),
            ["101", "102"],
        )
        self.assertFalse(ok, "reconcile_rc_subscription retries on False")

    def test_it_never_raises_when_ringcentral_is_unreachable(self):
        class Exploding(FakeClient):
            async def get(self, url, headers=None):
                raise RuntimeError("connection reset")

        ok, _client = _run(Exploding([]), ["101"])
        self.assertFalse(ok, "a failure is reported, not thrown")


class ExtensionsInTests(unittest.TestCase):
    def test_it_reads_extension_ids_back_out_of_filters(self):
        self.assertEqual(rcin._extensions_in(rcin.inbound_sms_filters(["101", "102"])), {"101", "102"})

    def test_the_shared_extension_is_not_an_extension_id(self):
        self.assertEqual(rcin._extensions_in([rcin.RC_INBOUND_SMS_FILTER]), set())

    def test_junk_does_not_throw(self):
        self.assertEqual(rcin._extensions_in([None, "", "not a filter"]), set())


if __name__ == "__main__":
    unittest.main()
