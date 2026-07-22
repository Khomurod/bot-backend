-- TABLE: admins (for web panel authentication)
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ─── Auto-migrations (safe to run every startup) ───
ALTER TABLE questions ADD COLUMN IF NOT EXISTS media_position TEXT DEFAULT 'above';
ALTER TABLE groups ADD COLUMN IF NOT EXISTS group_type TEXT DEFAULT 'driver';
ALTER TABLE groups ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS driver_birthday DATE;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS samsara_vehicle_id TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS status_source TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMP;
-- Bot visibility diagnostics: when the bot last RECEIVED any message from the
-- group (proves it can read it), and a cached snapshot of the bot's membership
-- role in the group (queried from Telegram on demand).
ALTER TABLE groups ADD COLUMN IF NOT EXISTS last_message_seen_at TIMESTAMPTZ;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS bot_member_status TEXT;
ALTER TABLE groups ADD COLUMN IF NOT EXISTS bot_access_checked_at TIMESTAMPTZ;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS last_name TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS secondary_first_name TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS secondary_last_name TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS first_name_source TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS last_name_source TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS secondary_first_name_source TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS secondary_last_name_source TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS driver_type TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS driver_type_source TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS unit_number TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS unit_number_source TEXT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS language VARCHAR(5) DEFAULT 'en';
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS date_of_start DATE;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS needs_review BOOLEAN DEFAULT FALSE;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS backfill_confidence SMALLINT;
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
-- Driver's Telegram @username, used to tag the driver in gas-station proximity
-- and check-in reminders. Stored without the leading '@'.
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS telegram_username TEXT;
-- Driver's numeric Telegram user id — the single source of truth for tagging,
-- selected in the admin Driver Groups popup from the group_members the bot has
-- captured. Lets buildMention() ping a driver WITHOUT an @username via an
-- inline <a href="tg://user?id=ID"> mention. Note the Telegram limitation:
-- such an inline mention only reliably notifies a user the bot has already
-- "seen" interact, which is why ids are captured broadly in bot/bot.js.
ALTER TABLE driver_profiles ADD COLUMN IF NOT EXISTS telegram_user_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'driver_profiles_driver_type_check'
      AND conrelid = 'driver_profiles'::regclass
  ) THEN
    ALTER TABLE driver_profiles
      ADD CONSTRAINT driver_profiles_driver_type_check
      CHECK (driver_type IS NULL OR driver_type IN ('owner', 'company_driver'));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'driver_profiles_status_check'
      AND conrelid = 'driver_profiles'::regclass
  ) THEN
    ALTER TABLE driver_profiles
      ADD CONSTRAINT driver_profiles_status_check
      CHECK (status IN ('active', 'inactive'));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'driver_profiles_language_check'
      AND conrelid = 'driver_profiles'::regclass
  ) THEN
    ALTER TABLE driver_profiles
      ADD CONSTRAINT driver_profiles_language_check
      CHECK (language IN ('en', 'ru', 'uz'));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'driver_profiles_backfill_confidence_check'
      AND conrelid = 'driver_profiles'::regclass
  ) THEN
    ALTER TABLE driver_profiles
      ADD CONSTRAINT driver_profiles_backfill_confidence_check
      CHECK (backfill_confidence IS NULL OR (backfill_confidence >= 0 AND backfill_confidence <= 100));
  END IF;
END
$$;

-- ─── Employee Voting System — RETIRED ───
-- The "Driver of the Week" employee voting feature was removed from the
-- application code (bot handlers, API routes, and admin page all deleted).
-- These tables are INTENTIONALLY RETAINED so existing historical vote data is
-- preserved and a fresh `init-db` run does not error. No application code
-- references them any more. They can be dropped manually AFTER a database
-- backup if the historical data is no longer needed; do not add an automatic
-- destructive migration.
