-- Migration 0015: a driver is a PERSON — the identity layer above `groups`
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: `groups` is three real-world things wearing one row — a PERSON
-- (driver_birthday), a TRUCK (samsara_vehicle_id, the unit parsed out of
-- group_name) and a TELEGRAM CHAT (telegram_group_id). Twenty foreign keys
-- point at groups(id), so every operational fact a driver accumulates is bound
-- to the chat rather than to the human.
--
-- What that costs, measured in production: 20 people hold two separate
-- driver_profiles; two of those pairs are BOTH active right now. When a driver's
-- Telegram group was recreated, the new group started with zero history and a
-- road clock reset to that day — losing roughly four weeks of accrual and the
-- bonus that went with it. Nothing in the application noticed.
--
-- WHAT THIS DOES: adds a person ABOVE groups, and nothing else. No foreign key
-- is repointed, no history is moved, no column is dropped. All 20 FKs keep
-- pointing at groups(id); a person is resolved THROUGH them. Every table here
-- is unread by the rest of the application until a later stage wires it in, so
-- this migration cannot change any existing behaviour.

-- ─────────────────────────────────────────────────────────────────────────
-- The person.
--
-- normalized_key is INDEXED BUT NOT UNIQUE, deliberately. Two different humans
-- really do normalize alike, and a UNIQUE constraint on a normalized name is
-- exactly the bug that already exists in mileage_bonus_progress
-- (driver_normalized_name TEXT UNIQUE): two drivers whose names collide merge
-- into one row and one of them silently stops being paid. A name is a search
-- key here, never an identity.
--
-- merged_into_person_id makes a merge a POINTER, not a deletion. Both people,
-- both groups and all their history stay exactly where they are; merging is
-- reversible by setting one column back to NULL.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS driver_people (
  id SERIAL PRIMARY KEY,
  display_name TEXT NOT NULL,
  normalized_key TEXT,
  date_of_birth DATE,
  notes TEXT,
  merged_into_person_id INTEGER NULL REFERENCES driver_people(id) ON DELETE SET NULL,
  created_source TEXT NOT NULL DEFAULT 'backfill'
    CHECK (created_source IN ('backfill', 'manual', 'bot', 'import')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A person cannot be merged into themselves; that would make the canonical
  -- lookup loop forever.
  CONSTRAINT driver_people_no_self_merge CHECK (merged_into_person_id IS NULL OR merged_into_person_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_driver_people_normalized_key ON driver_people (normalized_key);
CREATE INDEX IF NOT EXISTS idx_driver_people_canonical ON driver_people (id) WHERE merged_into_person_id IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- Person ↔ Telegram group, bounded in time.
--
-- A driver leaving and coming back on a NEW chat is the normal case, not an
-- anomaly: the old association is closed (ended_at) and a new one opened, and
-- the person — with every prior association still on record — is the same row.
--
-- association_source records HOW the link was decided, because the strength of
-- the evidence differs enormously. 'telegram_user_id' is a hard anchor: the
-- same human account texted in both chats. 'name_key' is a guess and must never
-- be created automatically.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS driver_person_groups (
  id SERIAL PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES driver_people(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ NULL,
  association_source TEXT NOT NULL
    CHECK (association_source IN ('backfill', 'manual', 'telegram_user_id', 'name_key', 'import', 'bot')),
  confidence SMALLINT NULL CHECK (confidence IS NULL OR (confidence BETWEEN 0 AND 100)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT driver_person_groups_ends_after_start
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

-- One chat belongs to at most one person AT A TIME. Closed associations are
-- unconstrained, so a chat's whole history of occupants is representable.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_driver_person_groups_open_group
  ON driver_person_groups (group_id) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_driver_person_groups_person
  ON driver_person_groups (person_id, started_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- Person ↔ truck, bounded in time.
--
-- unit_number is stored EXACTLY as written, never normalized. '001', '01' and
-- '1' are three different trucks in this fleet, each with its own driver;
-- stripping leading zeros to "tidy" them would fabricate collisions that do not
-- exist.
--
-- The two partial unique indexes are the point of this table. Production has 10
-- unit numbers sitting on multiple ACTIVE driver groups at once — unit '001' on
-- four of them. Today that is silent data. Here it is unrepresentable, so the
-- backfill has to leave the contested ones unclaimed and report them, and a
-- later stage turns each into a finding a human resolves.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS driver_units (
  id SERIAL PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES driver_people(id) ON DELETE CASCADE,
  unit_number TEXT NOT NULL,
  samsara_vehicle_id TEXT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ NULL,
  source TEXT NOT NULL
    CHECK (source IN ('backfill', 'manual', 'group_title', 'profile', 'samsara', 'import')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT driver_units_ends_after_start
    CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT driver_units_unit_not_blank CHECK (btrim(unit_number) <> '')
);

-- A person drives one truck at a time...
CREATE UNIQUE INDEX IF NOT EXISTS uniq_driver_units_open_person
  ON driver_units (person_id) WHERE ended_at IS NULL;

-- ...and a truck is driven by one person at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_driver_units_open_unit
  ON driver_units (unit_number) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_driver_units_person ON driver_units (person_id, started_at DESC);
