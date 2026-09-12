-- Migration 0046: the Dispatcher Board snapshot
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS TABLE IS: WHAT THE BOARD SAID, AND WHEN.
--
-- Not a second driver table. Every row is one line of somebody else's
-- spreadsheet as Wenze last read it, kept so that a disagreement between the
-- Board and Wenze can be SHOWN rather than guessed at, and so the Board's own
-- history is visible after a dispatcher edits it.
--
-- THE ROW KEY IS NOT THE SHEET ROW. `row` in the Board's JSON is a POSITION:
-- insert one line and every row below it renumbers while nothing about those
-- drivers changed. Keying on it would read as the whole fleet being replaced.
-- `row_key` is the truck plus the person, through the same normalizers a
-- Telegram group title goes through (lib/board/rowKey.js).
--
-- A ROW IS NEVER DELETED. One that stops appearing is marked `present = FALSE`,
-- because "this driver left the board on Tuesday" is a fact somebody will want
-- and a DELETE is the one edit that cannot be reviewed later.
--
-- `person_id` AND ITS TWO COMPANIONS ARE CREATED NOW AND WRITTEN LATER. Linking
-- a Board row to a person is its own stage with its own decision rules; the
-- columns are here so that stage needs no migration, and until then they are
-- null on every row.
--
-- NAMING: the trailer column is `board_trailer`, not `trailer`. Trailer
-- Tracking was retired and `tests/removedFeaturesStayRemoved.test.js` guards
-- the names it used. This is the Board's own field about somebody else's
-- document, not a resurrection of that feature.

CREATE TABLE IF NOT EXISTS dispatch_board_rows (
  id BIGSERIAL PRIMARY KEY,
  row_key TEXT NOT NULL UNIQUE,
  sheet_row INTEGER NULL,

  driver_name_raw TEXT NOT NULL,
  driver_name_clean TEXT NULL,
  fleet_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK (fleet_type IN ('company', 'lease', 'owner_operator', 'unknown')),
  fleet_label_raw TEXT NULL,
  fleet_label_normalised BOOLEAN NOT NULL DEFAULT FALSE,

  is_team BOOLEAN NOT NULL DEFAULT FALSE,
  team_members TEXT[] NULL,
  team_flag_mismatch BOOLEAN NOT NULL DEFAULT FALSE,

  truck_raw TEXT NULL,
  -- The EXACT key: leading zeros and letter suffixes kept. Company 001,
  -- Owner-Operator 001 and Lease 001 are three trucks (lib/board/truck.js).
  truck_norm TEXT NULL,
  -- The weak key, for generating candidates only. It may never justify a write.
  truck_digits TEXT NULL,
  board_trailer TEXT NULL,
  phone TEXT NULL,

  status TEXT NOT NULL DEFAULT 'UNKNOWN',
  status_raw TEXT NULL,
  -- Free text a dispatcher types. Stored verbatim, never parsed.
  eta_text TEXT NULL,
  origin_delivery TEXT NULL,
  notes TEXT NULL,
  dispatcher TEXT NULL,
  last_updated_by TEXT NULL,

  present BOOLEAN NOT NULL DEFAULT TRUE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Moves only when a field somebody cares about changed, so "nothing has
  -- happened to this driver since Friday" is answerable.
  last_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  person_id INTEGER NULL REFERENCES driver_people(id) ON DELETE SET NULL,
  link_source TEXT NULL,
  link_confidence SMALLINT NULL CHECK (link_confidence IS NULL OR link_confidence BETWEEN 0 AND 100),

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_board_rows_truck
  ON dispatch_board_rows (truck_norm) WHERE present;
CREATE INDEX IF NOT EXISTS idx_dispatch_board_rows_status
  ON dispatch_board_rows (status) WHERE present;
CREATE INDEX IF NOT EXISTS idx_dispatch_board_rows_person
  ON dispatch_board_rows (person_id) WHERE person_id IS NOT NULL;

COMMENT ON TABLE dispatch_board_rows IS
  'What the external Dispatcher Board said, as Wenze last read it. Rows are never deleted; a row that stops appearing goes present = FALSE.';
COMMENT ON COLUMN dispatch_board_rows.row_key IS
  'Truck plus person, NOT the sheet position — a spreadsheet renumbers when somebody inserts a line.';
COMMENT ON COLUMN dispatch_board_rows.truck_digits IS
  'The weak comparison key. Generates candidates; may never justify a write.';
