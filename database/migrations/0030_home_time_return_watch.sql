-- Migration 0030: remember where a driver's truck was parked when they went
-- home, so Wenze can tell when it leaves
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY THIS EXISTS AT ALL.
--
-- Drivers do not announce that they are back at work; they get a load and start
-- driving. Until now the only writer of `driver_road_history.return_to_road_at`
-- was a "Status: Ready" line typed into a chat, which is how production reached
-- 74 open cycles out of 79.
--
-- Deciding it from evidence needs two things this application does not have.
-- There is NO stored GPS history anywhere (`docs/architecture/live-locations.md`
-- says so outright — the map is live-only), and there is no recorded "home"
-- location for any driver: home time is derived from messages and has never
-- touched a coordinate. Without both, "the truck moved" cannot be asked, let
-- alone answered.
--
-- So this table is the minimum memory that makes the question answerable: one
-- row per driver who is currently home, holding where their truck was parked
-- (the anchor), the last few things seen about it, and the last verdict. It is
-- deliberately NOT a position history — it keeps the anchor, the latest
-- sighting and a running maximum, which is everything the evidence rules read
-- and nothing more.
--
-- The row is per CHAT (group_id), matching driver_home_status, and carries the
-- person id so the watch follows the human across a truck or group change.
CREATE TABLE IF NOT EXISTS home_time_return_watch (
  group_id INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  person_id INTEGER REFERENCES driver_people(id) ON DELETE SET NULL,
  -- The open cycle this watch belongs to, so the correction closes the right one.
  road_history_id INTEGER REFERENCES driver_road_history(id) ON DELETE SET NULL,
  home_since TIMESTAMPTZ,

  -- WHERE THE TRUCK WAS PARKED when the driver was home. Set from the first
  -- sighting that shows the truck stationary, never from a moving one — an
  -- anchor taken mid-drive would put "home" on an interstate and every later
  -- comparison would be meaningless.
  anchor_lat DOUBLE PRECISION,
  anchor_lng DOUBLE PRECISION,
  anchor_at TIMESTAMPTZ,
  anchor_source TEXT,

  -- The latest sighting, and the two running values the rules actually read.
  last_lat DOUBLE PRECISION,
  last_lng DOUBLE PRECISION,
  last_speed_mph DOUBLE PRECISION,
  last_seen_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  -- Furthest the truck has been from its anchor during this stay.
  max_miles_from_anchor DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- How many separate sightings showed it moving. One is a glitch; two is a trip.
  moving_sightings INTEGER NOT NULL DEFAULT 0,

  -- What Datatruck says the driver is working, if anything.
  load_identifier TEXT,
  load_status TEXT,
  load_first_seen_at TIMESTAMPTZ,
  load_pickup_at TIMESTAMPTZ,

  -- The last verdict, so the admin and /api/health can see what Wenze thinks
  -- without re-running the evidence.
  last_confidence TEXT CHECK (last_confidence IN ('high', 'medium', 'low')),
  last_score INTEGER,
  last_signals JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The worker's read: everyone currently watched, oldest check first.
CREATE INDEX IF NOT EXISTS idx_home_time_return_watch_checked
  ON home_time_return_watch (last_checked_at ASC NULLS FIRST);

CREATE INDEX IF NOT EXISTS idx_home_time_return_watch_person
  ON home_time_return_watch (person_id)
  WHERE person_id IS NOT NULL;

-- ─── The automatic Home → Road change, switched on ───────────────────────────
-- Default deny is the engine's rule: a check with no settings row applies
-- nothing. This one is seeded ON because it is the point of the work — the
-- owner asked for a driver's real return to be detected automatically — and
-- because it is the safest auto action in the registry to enable: it refuses
-- unless a load AND proven truck movement are both present, it re-derives that
-- evidence at apply time and stands down if it has changed, and it is
-- revertible from Needs Attention → History like every other correction.
--
-- The cap is 25. Sixteen drivers are at home in a normal week, so 25 leaves
-- room without ever letting a bug move a fleet: a pass that wants more applies
-- NOTHING and files a serious finding about itself.
--
-- ON CONFLICT DO NOTHING, so an administrator switching it off in Needs
-- Attention → Automation stays switched off across every future boot.
INSERT INTO operational_check_settings (check_key, auto_apply_enabled, max_auto_per_run, updated_by, updated_at)
VALUES ('home_time.returned_to_road', TRUE, 25, 'migration 0030 (automatic return-to-road detection)', NOW())
ON CONFLICT (check_key) DO NOTHING;

-- ─── The kill switch an administrator can actually reach ─────────────────────
-- The router refuses a capability whose `ai_enabled` is FALSE, and a capability
-- with no row at all is treated as enabled — which is right for a fresh install
-- but leaves the switch INVISIBLE: Settings → AI lists the rows in this table,
-- so a capability that is never registered cannot be switched off by anyone.
--
-- Seeding the row is the whole fix. The defaults match the code:
--   sends_raw_text          FALSE — the reasoner is handed a scored, structured
--                           evidence summary (distances, speeds, load status),
--                           never a driver's chat messages.
--   has_deterministic_fallback TRUE — scoreReturnToRoad() decides on its own and
--                           the AI may only lower the verdict, or raise a medium
--                           to high when movement and a load are both proven. AI
--                           being off costs accuracy, never correctness.
INSERT INTO ai_capabilities (capability_key, label, sends_raw_text, has_deterministic_fallback)
VALUES ('home_time_return_to_road', 'Home Time — is the driver back on the road?', FALSE, TRUE)
ON CONFLICT (capability_key) DO NOTHING;
