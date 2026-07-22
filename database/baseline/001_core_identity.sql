-- Telegram Driver Feedback System - Database Schema

-- TABLE: groups
CREATE TABLE IF NOT EXISTS groups (
  id SERIAL PRIMARY KEY,
  telegram_group_id BIGINT UNIQUE NOT NULL,
  group_name TEXT,
  language VARCHAR(5) DEFAULT 'en',
  group_type TEXT DEFAULT 'driver',
  created_at TIMESTAMP DEFAULT NOW()
);

-- TABLE: driver_profiles (future source of truth for driver identity fields)
CREATE TABLE IF NOT EXISTS driver_profiles (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  first_name TEXT,
  last_name TEXT,
  secondary_first_name TEXT,
  secondary_last_name TEXT,
  first_name_source TEXT,
  last_name_source TEXT,
  secondary_first_name_source TEXT,
  secondary_last_name_source TEXT,
  driver_type TEXT,
  driver_type_source TEXT,
  status TEXT DEFAULT 'active',
  unit_number TEXT,
  unit_number_source TEXT,
  language VARCHAR(5) DEFAULT 'en',
  date_of_birth DATE,
  date_of_start DATE,
  needs_review BOOLEAN DEFAULT FALSE,
  backfill_confidence SMALLINT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT driver_profiles_group_id_unique UNIQUE (group_id),
  CONSTRAINT driver_profiles_driver_type_check CHECK (
    driver_type IS NULL OR driver_type IN ('owner', 'company_driver')
  ),
  CONSTRAINT driver_profiles_status_check CHECK (
    status IN ('active', 'inactive')
  ),
  CONSTRAINT driver_profiles_language_check CHECK (
    language IN ('en', 'ru', 'uz')
  ),
  CONSTRAINT driver_profiles_backfill_confidence_check CHECK (
    backfill_confidence IS NULL OR (backfill_confidence >= 0 AND backfill_confidence <= 100)
  )
);

-- TABLE: drivers
CREATE TABLE IF NOT EXISTS drivers (
  id SERIAL PRIMARY KEY,
  telegram_user_id BIGINT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- TABLE: group_members — which Telegram users the bot has SEEN in each group.
-- The Bot API cannot enumerate a group's full member list (only getChatMember
-- for one known user, getChatAdministrators, and getChatMemberCount), so this
-- table is populated opportunistically from every update the bot receives
-- (senders, added/removed members, reply authors). Silent members who never
-- interact will NOT appear here. It powers the "Driver Username" dropdown in
-- the admin Driver Groups popup.
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  telegram_user_id BIGINT NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (group_id, telegram_user_id)
);
