-- ─── 75¢/mile Driver Raise Approval ──────────────────────────────────────────
-- Dispatch teams (groups of dispatch specialists). Each team is linked to a set
-- of active company drivers it is responsible for.
CREATE TABLE IF NOT EXISTS dispatch_teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Company drivers assigned to a dispatch team.
--
-- Source of truth is now Driver Groups / driver_profiles (linked by
-- driver_profile_id + group_id). The driver_name / driver_normalized_name
-- columns are kept as a SNAPSHOT so the public raise-review form and
-- raise_round_picks stay historically stable even if a profile later changes,
-- and so legacy Datatruck-name rows (driver_external_id, no profile link)
-- keep working. driver_normalized_name uses normalizeDriverName() (UPPERCASE).
CREATE TABLE IF NOT EXISTS dispatch_team_drivers (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES dispatch_teams(id) ON DELETE CASCADE,
  driver_external_id TEXT,
  driver_normalized_name TEXT NOT NULL,
  driver_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team_id, driver_normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_dispatch_team_drivers_team
  ON dispatch_team_drivers(team_id);

-- Driver Groups as the source of truth: link each assignment to a driver
-- profile / group, keep a unit snapshot, and let assignments be soft-disabled.
-- needs_review flags legacy name-only rows that could not be linked to a profile.
ALTER TABLE dispatch_team_drivers ADD COLUMN IF NOT EXISTS driver_profile_id INTEGER
  REFERENCES driver_profiles(id) ON DELETE SET NULL;
ALTER TABLE dispatch_team_drivers ADD COLUMN IF NOT EXISTS group_id INTEGER
  REFERENCES groups(id) ON DELETE SET NULL;
ALTER TABLE dispatch_team_drivers ADD COLUMN IF NOT EXISTS unit_number TEXT;
ALTER TABLE dispatch_team_drivers ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE dispatch_team_drivers ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE dispatch_team_drivers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- A driver normally belongs to ONE active dispatch team at a time. Enforce it at
-- the DB level per driver profile and per group (partial unique — only over
-- active, linked rows; legacy name-only rows with NULL links are unaffected).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_dispatch_active_driver_profile
  ON dispatch_team_drivers(driver_profile_id)
  WHERE active AND driver_profile_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_dispatch_active_driver_group
  ON dispatch_team_drivers(group_id)
  WHERE active AND group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dispatch_team_drivers_profile
  ON dispatch_team_drivers(driver_profile_id) WHERE driver_profile_id IS NOT NULL;

-- Dispatch team MEMBERS (dispatchers). Their Telegram username authorizes them
-- to assign routes from Telegram (Route Control, see routeControlService).
-- telegram_username is stored WITHOUT a leading '@' and lowercased; compared
-- case-insensitively. telegram_user_id is the stable numeric id when known.
CREATE TABLE IF NOT EXISTS dispatch_team_members (
  id SERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES dispatch_teams(id) ON DELETE CASCADE,
  name TEXT NULL,
  telegram_username TEXT NULL,
  telegram_user_id BIGINT NULL,
  role TEXT NULL CHECK (role IS NULL OR role IN ('dispatcher', 'lead_dispatcher', 'manager')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_team_members_team
  ON dispatch_team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_team_members_username
  ON dispatch_team_members(telegram_username) WHERE telegram_username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dispatch_team_members_user_id
  ON dispatch_team_members(telegram_user_id) WHERE telegram_user_id IS NOT NULL;
