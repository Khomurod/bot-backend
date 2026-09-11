-- Migration 0032: remember where each load actually is, so Wenze can tell what
-- a driver is doing without being told
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY A TABLE IS NEEDED AT ALL.
--
-- Most of a load's phase is observable right now: "at pickup" is a distance you
-- can measure from the truck's current position to the shipper's coordinates.
-- Two of them are not.
--
-- "Loaded and moving" means the truck WAS at the shipper and has since left.
-- "Delivered" means it WAS at the receiver and has since left. Both are
-- departures, and a departure cannot be seen in a single snapshot — a truck 200
-- miles from a receiver it never reached looks identical to one 200 miles past
-- a receiver it emptied at.
--
-- So this row holds the minimum that makes those two answerable: whether the
-- arrival was ever witnessed, and what the last verdict was. It is deliberately
-- NOT a position history. The application has no stored GPS history anywhere
-- (docs/architecture/live-locations.md says so outright) and this does not start
-- one: the latest sighting overwrites the previous one.
CREATE TABLE IF NOT EXISTS load_lifecycle (
  -- Datatruck's own order id. One row per load, not per driver: a load reassigned
  -- to another truck is the same load, and its witnessed arrivals still stand.
  order_id TEXT PRIMARY KEY,
  load_identifier TEXT,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  person_id INTEGER REFERENCES driver_people(id) ON DELETE SET NULL,
  unit_number TEXT,

  phase TEXT NOT NULL DEFAULT 'assigned'
    CHECK (phase IN ('assigned', 'heading_to_pickup', 'at_pickup', 'in_transit',
                     'at_delivery', 'delivered', 'empty')),
  phase_since TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confidence TEXT CHECK (confidence IN ('high', 'medium', 'low')),

  -- THE TWO WITNESSED ARRIVALS. Once true, never false: a truck that reached the
  -- shipper reached it, and a later position outside the radius is the departure
  -- this column exists to make readable, not evidence the arrival never happened.
  was_at_pickup BOOLEAN NOT NULL DEFAULT FALSE,
  was_at_delivery BOOLEAN NOT NULL DEFAULT FALSE,
  first_at_pickup_at TIMESTAMPTZ,
  first_at_delivery_at TIMESTAMPTZ,

  -- The latest sighting, overwritten each pass. Not a history.
  last_lat DOUBLE PRECISION,
  last_lng DOUBLE PRECISION,
  last_speed_mph DOUBLE PRECISION,
  last_seen_at TIMESTAMPTZ,
  miles_to_pickup DOUBLE PRECISION,
  miles_to_delivery DOUBLE PRECISION,

  -- What dispatch believes, kept beside what was observed so a disagreement is
  -- readable without re-fetching the board.
  board_status TEXT,
  signals JSONB,
  conflicts JSONB,

  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The worker's read: everything being tracked, oldest check first.
CREATE INDEX IF NOT EXISTS idx_load_lifecycle_checked
  ON load_lifecycle (last_checked_at ASC NULLS FIRST);

-- "What is this driver carrying right now", which is the question every other
-- feature asks of this table.
CREATE INDEX IF NOT EXISTS idx_load_lifecycle_group
  ON load_lifecycle (group_id, updated_at DESC)
  WHERE group_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_load_lifecycle_person
  ON load_lifecycle (person_id, updated_at DESC)
  WHERE person_id IS NOT NULL;

-- The unclear cases, for Needs attention.
CREATE INDEX IF NOT EXISTS idx_load_lifecycle_unclear
  ON load_lifecycle (confidence, updated_at DESC)
  WHERE confidence <> 'high';
