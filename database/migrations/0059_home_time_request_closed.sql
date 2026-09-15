-- Home Time: a request is recorded and delivered, and then it is DONE.
--
-- WHAT THIS RETIRES. A home-time request used to be a small workflow with an
-- unhappy ending: nothing happened before the requested dates arrived, so the
-- row was stamped 'expired', a sweep reported how many had "expired without an
-- answer", and the retention watch read that count as evidence the company had
-- let the driver down — which is how a quiet week turned into "34 drivers worth
-- a call". None of it described anything a driver or a manager actually did.
--
-- The request is now simply a message: the driver asks, three managers are
-- told, and the row is closed once its window has passed. Closing it is
-- housekeeping — it stops a finished request blocking the next one — and it is
-- not a judgement about anybody, so it gets a status that does not read like
-- one.
--
-- 'expired' STAYS IN THE CHECK, and no existing row is rewritten. Those rows
-- record what the application really did at the time, and a status list that
-- refuses a value already in the table would fail this migration on boot
-- anyway. Nothing writes it from here on; 'closed' takes its place.
--
-- Additive and idempotent.

ALTER TABLE home_time_requests
  DROP CONSTRAINT IF EXISTS home_time_requests_status_check;

ALTER TABLE home_time_requests
  ADD CONSTRAINT home_time_requests_status_check
  CHECK (status IN ('pending', 'recorded', 'approved', 'denied', 'cancelled',
    'awaiting_dates', 'awaiting_home_start', 'awaiting_return_to_road',
    'clarification_unanswered', 'expired', 'closed'));
