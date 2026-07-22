CREATE TABLE IF NOT EXISTS home_time_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  road_allowance_weeks INTEGER NOT NULL DEFAULT 4 CHECK (road_allowance_weeks BETWEEN 1 AND 52),
  home_allowance_days INTEGER NOT NULL DEFAULT 4 CHECK (home_allowance_days BETWEEN 1 AND 60),
  bonus_per_week NUMERIC(10,2) NOT NULL DEFAULT 100,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO home_time_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Conversational clarification reminders: how long to wait before the first and
-- second (and final) reminder when a driver has not supplied a missing home-time
-- date. Configurable so the cadence can be tuned without a code change. Defaults
-- to 12h + 12h. See services/homeTimeReminderService.js.
ALTER TABLE home_time_settings
  ADD COLUMN IF NOT EXISTS reminder_first_hours INTEGER NOT NULL DEFAULT 12
    CHECK (reminder_first_hours BETWEEN 1 AND 168);
ALTER TABLE home_time_settings
  ADD COLUMN IF NOT EXISTS reminder_second_hours INTEGER NOT NULL DEFAULT 12
    CHECK (reminder_second_hours BETWEEN 1 AND 168);

-- Telegram chat id (stored as text to keep full precision on large negative
-- supergroup ids) that receives COMPLETED home-time request cards. When NULL the
-- completed card is not posted at all — it is NEVER sent to the driver's own
-- group. Date-clarification asks and the <allowance policy reminder still go to
-- the driver group (see services/homeTimeRequestService.js).
ALTER TABLE home_time_settings
  ADD COLUMN IF NOT EXISTS completed_notify_group_id TEXT;

-- Current home/road state for each driver group (one row per group).
CREATE TABLE IF NOT EXISTS driver_home_status (
  group_id INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  telegram_group_id BIGINT,
  state TEXT NOT NULL CHECK (state IN ('home', 'road')),
  state_since TIMESTAMPTZ NOT NULL,
  last_status_text TEXT,
  last_status_at TIMESTAMPTZ NOT NULL,
  -- Watermark: how many FULL extra-week milestones (beyond the road allowance)
  -- have already been posted to the Bonus Penalty group for the CURRENT road
  -- leg. Reset to 0 whenever a new road leg begins so the same week is never
  -- double-posted. See services/roadBonusNotifierService.js.
  road_bonus_weeks_notified INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Older deployments created driver_home_status before the watermark existed.
ALTER TABLE driver_home_status
  ADD COLUMN IF NOT EXISTS road_bonus_weeks_notified INTEGER NOT NULL DEFAULT 0;

-- One row per completed road trip (closed when the driver goes home).
CREATE TABLE IF NOT EXISTS driver_road_history (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  driver_name TEXT,
  unit_number TEXT,
  road_started_at TIMESTAMPTZ NOT NULL,
  home_arrived_at TIMESTAMPTZ NOT NULL,
  days_on_road INTEGER NOT NULL,
  exceeded_weeks INTEGER NOT NULL DEFAULT 0,
  bonus_usd NUMERIC(10,2) NOT NULL DEFAULT 0,
  -- When the single "extra-week bonus" summary for this completed road leg was
  -- posted to the configured Extra Week / Road Bonus group. NULL = not yet
  -- posted. This is the DB-side idempotency key: the summary is posted at most
  -- once per completed leg, surviving restarts, repeated syncs and repeated
  -- status updates. See services/roadBonusNotifierService.js.
  bonus_posted_at TIMESTAMPTZ NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Older deployments created driver_road_history before per-leg bonus posting.
ALTER TABLE driver_road_history
  ADD COLUMN IF NOT EXISTS bonus_posted_at TIMESTAMPTZ NULL;

-- Home-Time Efficiency needs BOTH sides of a cycle: time on the road (already
-- captured by road_started_at → home_arrived_at) AND the home stay that follows.
-- These columns close the home stay when the driver goes back on the road:
--   return_to_road_at — actual home→road transition time (NULL while still home);
--   home_days         — whole days spent home (return_to_road_at − home_arrived_at);
--   linked_request_id — the decided home-time request this cycle maps to, so an
--                       APPROVED longer-than-policy stay counts as an approved
--                       exception rather than an ordinary violation.
-- A cycle is "complete" (usable for strict efficiency) once return_to_road_at is
-- set. Additive + idempotent: existing rows keep NULLs and are simply treated as
-- incomplete home-side data until a future home→road transition fills them.
ALTER TABLE driver_road_history
  ADD COLUMN IF NOT EXISTS return_to_road_at TIMESTAMPTZ NULL;
ALTER TABLE driver_road_history
  ADD COLUMN IF NOT EXISTS home_days INTEGER NULL;
ALTER TABLE driver_road_history
  ADD COLUMN IF NOT EXISTS linked_request_id INTEGER NULL;

-- Backfill: mark every EXISTING completed leg as already-posted so switching to
-- the road→home summary flow does not re-announce historical trips. Only legs
-- completed AFTER this migration (bonus_posted_at left NULL by default) will be
-- posted once. Runs once — subsequent rows are inserted with NULL and posted.
UPDATE driver_road_history
   SET bonus_posted_at = COALESCE(recorded_at, NOW())
 WHERE bonus_posted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_driver_road_history_group
  ON driver_road_history(group_id, home_arrived_at DESC);
CREATE INDEX IF NOT EXISTS idx_driver_road_history_bonus
  ON driver_road_history(home_arrived_at DESC) WHERE bonus_usd > 0;
-- Fast lookup of completed legs still awaiting their bonus summary.
CREATE INDEX IF NOT EXISTS idx_driver_road_history_unposted
  ON driver_road_history(home_arrived_at ASC) WHERE bonus_usd > 0 AND bonus_posted_at IS NULL;
-- The still-open home stay for a group (home_arrived_at set, not yet back on road)
-- is the row a home→road transition closes.
CREATE INDEX IF NOT EXISTS idx_driver_road_history_open_home
  ON driver_road_history(group_id, home_arrived_at DESC) WHERE return_to_road_at IS NULL;

-- Home-time REQUESTS: every time a driver asks for home time (via the bot when a
-- rep tags an approver, or entered manually in the admin panel). Keeping all of
-- them lets us spot drivers who violate the policy (4 weeks on the road / 4 days
-- home).
CREATE TABLE IF NOT EXISTS home_time_requests (
  id SERIAL PRIMARY KEY,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  telegram_group_id BIGINT,
  driver_name TEXT,
  unit_number TEXT,
  requested_by_user_id BIGINT,
  requested_by_username TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  road_started_at TIMESTAMPTZ,
  days_on_road INTEGER,
  policy_met BOOLEAN,
  home_from DATE,
  home_to DATE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
  source TEXT NOT NULL DEFAULT 'telegram'
    CHECK (source IN ('telegram', 'manual')),
  ai_reasoning TEXT,
  telegram_chat_id BIGINT,
  telegram_message_id BIGINT,
  decided_by_username TEXT,
  decided_by_user_id BIGINT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Conversational home-time flow (AI clarification, partial dates, reminders) ──
-- DATE MODEL (normalized — do not mix these up):
--   home_from            = HOME START DATE  (day the driver arrives home)
--   return_to_road_date  = day the driver leaves home to go back on the road
--   home_to              = LAST DAY HOME    (= return_to_road_date − 1), kept for
--                          back-compat/display. homeDays = return_to_road − home_from.
-- A single supplied date is NEVER copied into both ends: the unknown end stays NULL
-- and the flow asks for it.
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS return_to_road_date DATE;
-- Driver went home with no earlier complete request — an "unplanned home arrival"
-- clarification (we know the start from the Status: Home date, still need the
-- return-to-road date).
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS is_unplanned_arrival BOOLEAN NOT NULL DEFAULT FALSE;
-- AI audit: what the model decided, how sure, the driver's language, and which
-- date fields were still missing when the row was last touched.
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS detected_intent TEXT;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS ai_confidence INTEGER;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS language TEXT;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS missing_fields TEXT;
-- Telegram reply threading. root_* = the message that STARTED this flow (the
-- original request / Status: Home / incomplete-date message) — clarifications and
-- reminders reply to it. clarification_* = the bot's own question message.
-- last_driver_message_id = the most recent driver message we acted on (final ack
-- replies to it).
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS root_chat_id BIGINT;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS root_message_id BIGINT;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS clarification_chat_id BIGINT;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS clarification_message_id BIGINT;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS last_driver_message_id BIGINT;
-- Restart-safe reminder scheduling. next_reminder_at drives the worker (NULL =
-- nothing scheduled); reminder_count caps at 2. See homeTimeReminderService.js.
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS reminder_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS next_reminder_at TIMESTAMPTZ;
-- The conversational acknowledgment / policy reminder is sent at most once per
-- request (idempotency guard); policy_result records the evaluation outcome.
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;
ALTER TABLE home_time_requests
  ADD COLUMN IF NOT EXISTS policy_result TEXT;

-- Status lifecycle:
--   awaiting_dates        — need BOTH home-start and return-to-road (generic).
--   awaiting_home_start   — have return-to-road, need the home-start date.
--   awaiting_return_to_road — have home-start (or Status: Home), need return date.
--   pending               — dates complete, approval card posted, awaiting a human.
--   approved / denied / cancelled — human decision (approval stays authoritative).
--   clarification_unanswered — two reminders sent, no answer → manual follow-up.
--   expired               — flow abandoned (driver returned to road, etc.).
ALTER TABLE home_time_requests
  DROP CONSTRAINT IF EXISTS home_time_requests_status_check;
ALTER TABLE home_time_requests
  ADD CONSTRAINT home_time_requests_status_check
  CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'awaiting_dates',
    'awaiting_home_start', 'awaiting_return_to_road', 'clarification_unanswered', 'expired'));

CREATE INDEX IF NOT EXISTS idx_home_time_requests_group
  ON home_time_requests(group_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_home_time_requests_status
  ON home_time_requests(status, requested_at DESC);
-- Drives the restart-safe reminder sweep: due, still-open clarifications only.
CREATE INDEX IF NOT EXISTS idx_home_time_requests_reminder_due
  ON home_time_requests(next_reminder_at ASC)
  WHERE next_reminder_at IS NOT NULL
    AND status IN ('awaiting_dates', 'awaiting_home_start', 'awaiting_return_to_road');
