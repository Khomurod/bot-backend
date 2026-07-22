-- Master list of trailers (one row per unit number).
CREATE TABLE IF NOT EXISTS trailers (
  id SERIAL PRIMARY KEY,
  unit_number TEXT UNIQUE NOT NULL,
  make TEXT NULL,
  model TEXT NULL,
  mc_number TEXT NULL,
  plate_number TEXT NULL,
  type TEXT NULL,
  vin TEXT NULL,
  year TEXT NULL,
  ownership_status TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  -- 'admin_manual' | 'screenshot_import' | 'telegram_detected'
  source TEXT NOT NULL DEFAULT 'admin_manual',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailers_unit_number ON trailers(unit_number);
CREATE INDEX IF NOT EXISTS idx_trailers_plate ON trailers(plate_number);
CREATE INDEX IF NOT EXISTS idx_trailers_vin ON trailers(vin);

-- Immutable event ledger — one row per detected/registered pickup, drop-off,
-- mention, or unidentified command. The (telegram_group_id, telegram_message_id)
-- pair is the dedupe guard: the same Telegram message can never create two rows.
CREATE TABLE IF NOT EXISTS trailer_events (
  id BIGSERIAL PRIMARY KEY,
  trailer_id INTEGER NULL REFERENCES trailers(id) ON DELETE SET NULL,
  trailer_unit_number TEXT NULL,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('pickup', 'dropoff', 'mention_only', 'unidentified')),
  -- Two-dimension status: possession (who holds it) + cargo (loaded/empty).
  possession_status TEXT NOT NULL DEFAULT 'unknown',   -- with_driver | dropped | unknown
  cargo_status TEXT NOT NULL DEFAULT 'unknown',         -- empty | loaded | unknown
  confidence SMALLINT NULL,
  driver_group_id INTEGER NULL REFERENCES groups(id) ON DELETE SET NULL,
  telegram_group_id BIGINT NULL,
  telegram_group_name TEXT NULL,
  driver_profile_id INTEGER NULL REFERENCES driver_profiles(id) ON DELETE SET NULL,
  driver_name TEXT NULL,
  reported_by_telegram_user_id BIGINT NULL,
  reported_by_username TEXT NULL,
  reported_by_name TEXT NULL,
  reported_driver_name_from_message TEXT NULL,
  location_text TEXT NULL,
  location_lat DOUBLE PRECISION NULL,
  location_lng DOUBLE PRECISION NULL,
  location_missing BOOLEAN NOT NULL DEFAULT FALSE,
  condition_text TEXT NULL,
  event_date_text TEXT NULL,
  event_time TIMESTAMPTZ NULL,
  telegram_message_id BIGINT NULL,
  telegram_media_group_id TEXT NULL,
  -- Photo/file evidence and any structured extras (Telegram file_ids, etc.).
  evidence JSONB NULL,
  raw_message_text TEXT NULL,
  ai_summary TEXT NULL,
  unidentified_reason TEXT NULL,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  reported_to_test_group BOOLEAN NOT NULL DEFAULT FALSE,
  source TEXT NOT NULL DEFAULT 'telegram',   -- 'telegram' | 'admin_manual'
  beta_mode BOOLEAN NOT NULL DEFAULT TRUE,
  -- Multi-event support: one Telegram message may name several trailers, so the
  -- dedupe key is (group, message, event_index) rather than (group, message).
  -- Existing rows default to 0 (they were always the single event per message).
  event_index INTEGER NOT NULL DEFAULT 0,
  -- Review workflow (accept / decline / edit). Historical rows are treated as
  -- already-accepted; only NEW auto-detected pickup/dropoff events start pending.
  review_status TEXT NOT NULL DEFAULT 'accepted'
    CHECK (review_status IN ('pending', 'accepted', 'declined', 'edited')),
  reviewed_by TEXT NULL,
  reviewed_at TIMESTAMPTZ NULL,
  review_note TEXT NULL,
  corrected_by TEXT NULL,
  corrected_at TIMESTAMPTZ NULL,
  correction_note TEXT NULL,
  superseded_by_event_id BIGINT NULL,
  original_event_snapshot JSONB NULL,
  -- Location precision provenance: exact | geocoded | approximate_state |
  -- derived_from_driver | text_only | manual (see services/trailerGeocodeService).
  location_source TEXT NULL,
  location_confidence SMALLINT NULL,
  geocoded_at TIMESTAMPTZ NULL,
  geocode_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_events_trailer ON trailer_events(trailer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trailer_events_type ON trailer_events(event_type, created_at DESC);
-- Additive migration for databases created before the review/multi-event
-- columns existed (CREATE TABLE IF NOT EXISTS above is a no-op on them). Every
-- statement is idempotent (ADD COLUMN IF NOT EXISTS) so re-running is safe and
-- can never fail boot.
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS event_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'accepted';
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS reviewed_by TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS review_note TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS corrected_by TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS corrected_at TIMESTAMPTZ NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS correction_note TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS superseded_by_event_id BIGINT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS original_event_snapshot JSONB NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS location_source TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS location_confidence SMALLINT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS geocoded_at TIMESTAMPTZ NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS geocode_error TEXT NULL;
-- Two-dimension status model (unified trailer state service). Possession is who
-- holds the trailer; cargo is whether it carries a load. Plain TEXT (validated
-- in app code) so re-running these ALTERs can never fail on a named CHECK.
-- Values: possession_status ∈ with_driver | dropped | unknown
--         cargo_status      ∈ empty | loaded | unknown
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS possession_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS cargo_status TEXT NOT NULL DEFAULT 'unknown';
-- Semantic AI verification audit (mandatory verification layer). Every
-- Telegram-registered pickup/drop-off records WHY it was allowed: the verified
-- intent, per-event completion + confidence, how the unit was grounded
-- (current/replied text/caption or image), the exact evidence quotes, and the
-- verification status (approved | review | rejected | unavailable |
-- invalid_response). raw_ai_result stores the sanitized normalized AI JSON —
-- never full prompts or conversation history.
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS semantic_intent TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS semantic_completed BOOLEAN NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS semantic_confidence SMALLINT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS semantic_reason TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS unit_grounded BOOLEAN NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS unit_source TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS unit_evidence TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS action_evidence TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS ai_model TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS ai_verified_at TIMESTAMPTZ NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS ai_verification_status TEXT NULL;
ALTER TABLE trailer_events ADD COLUMN IF NOT EXISTS raw_ai_result JSONB NULL;
-- Dedupe guard (multi-event): at most one event per (group, message, event_index).
-- Partial so admin_manual rows (message_id NULL) are never blocked.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_trailer_events_tg_message_event
  ON trailer_events(telegram_group_id, telegram_message_id, event_index)
  WHERE telegram_group_id IS NOT NULL AND telegram_message_id IS NOT NULL;
-- Retire the old 2-column dedupe index (superseded by the 3-column one above).
-- IF EXISTS keeps this safe on both fresh installs and already-migrated DBs.
DROP INDEX IF EXISTS uniq_trailer_events_tg_message;

-- Fast "where is each trailer now" snapshot, maintained from the latest
-- pickup/dropoff event. One row per trailer.
CREATE TABLE IF NOT EXISTS trailer_current_status (
  trailer_id INTEGER PRIMARY KEY REFERENCES trailers(id) ON DELETE CASCADE,
  unit_number TEXT NOT NULL,
  current_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (current_status IN ('with_driver', 'dropped', 'unknown')),
  -- Unified state model. possession_status mirrors current_status (kept in sync
  -- for clarity); cargo_status + display_status are the new two-dimension view.
  possession_status TEXT NOT NULL DEFAULT 'unknown',   -- with_driver | dropped | unknown
  cargo_status TEXT NOT NULL DEFAULT 'unknown',         -- empty | loaded | unknown
  display_status TEXT NULL,                             -- e.g. 'Dropped / Empty'
  current_driver_group_id INTEGER NULL REFERENCES groups(id) ON DELETE SET NULL,
  current_driver_profile_id INTEGER NULL REFERENCES driver_profiles(id) ON DELETE SET NULL,
  current_driver_name TEXT NULL,
  current_location_text TEXT NULL,
  current_lat DOUBLE PRECISION NULL,
  current_lng DOUBLE PRECISION NULL,
  current_condition TEXT NULL,
  last_reporter_name TEXT NULL,
  last_event_id BIGINT NULL REFERENCES trailer_events(id) ON DELETE SET NULL,
  last_event_type TEXT NULL,
  last_event_at TIMESTAMPTZ NULL,
  -- Set when the latest pickup/dropoff event is still pending human review.
  -- Drives the "• review" badge and the drawer review panel.
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  pending_event_id BIGINT NULL,
  -- Precision of current_lat/current_lng (mirrors trailer_events.location_source).
  location_source TEXT NULL,
  location_confidence SMALLINT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_current_status_unit ON trailer_current_status(unit_number);
CREATE INDEX IF NOT EXISTS idx_trailer_current_status_state ON trailer_current_status(current_status);
-- Additive migration for pre-review databases (idempotent).
ALTER TABLE trailer_current_status ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE trailer_current_status ADD COLUMN IF NOT EXISTS pending_event_id BIGINT NULL;
ALTER TABLE trailer_current_status ADD COLUMN IF NOT EXISTS location_source TEXT NULL;
ALTER TABLE trailer_current_status ADD COLUMN IF NOT EXISTS location_confidence SMALLINT NULL;
-- Two-dimension status (unified state service). Backfill possession_status from
-- the legacy current_status once; cargo defaults to unknown until the next event.
ALTER TABLE trailer_current_status ADD COLUMN IF NOT EXISTS possession_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE trailer_current_status ADD COLUMN IF NOT EXISTS cargo_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE trailer_current_status ADD COLUMN IF NOT EXISTS display_status TEXT NULL;
UPDATE trailer_current_status
   SET possession_status = current_status
 WHERE possession_status = 'unknown' AND current_status IN ('with_driver', 'dropped');

-- Admin screenshot-import batches (one per uploaded image set).
CREATE TABLE IF NOT EXISTS trailer_import_batches (
  id SERIAL PRIMARY KEY,
  uploaded_by TEXT NULL,
  file_name TEXT NULL,
  status TEXT NOT NULL DEFAULT 'parsed'
    CHECK (status IN ('parsed', 'committed', 'failed')),
  parsed_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  raw_ai_result JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Extracted rows for a batch (admin reviews/edits before commit).
CREATE TABLE IF NOT EXISTS trailer_import_rows (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES trailer_import_batches(id) ON DELETE CASCADE,
  unit_number TEXT NULL,
  make TEXT NULL,
  model TEXT NULL,
  mc_number TEXT NULL,
  plate_number TEXT NULL,
  type TEXT NULL,
  vin TEXT NULL,
  year TEXT NULL,
  ownership_status TEXT NULL,
  confidence SMALLINT NULL,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  raw_row JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_import_rows_batch ON trailer_import_rows(batch_id);

-- Single-row runtime settings for the Trailer feature (Beta). Admin-editable.
CREATE TABLE IF NOT EXISTS trailer_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  beta_mode BOOLEAN NOT NULL DEFAULT TRUE,
  -- NULL → fall back to config.trailerTestGroupId (env).
  automatic_update_test_group_id TEXT NULL,
  send_driver_group_confirmation BOOLEAN NOT NULL DEFAULT TRUE,
  send_reaction BOOLEAN NOT NULL DEFAULT TRUE,
  ai_fallback_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  geocoding_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO trailer_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
-- Semantic-verification settings (additive, idempotent).
--   semantic_ai_required: when TRUE (default) no Telegram trailer message may
--     change status without passing AI semantic verification — if the AI is
--     unavailable the candidate FAILS CLOSED to review.
--   auto_register_confidence: minimum per-event AI confidence for automatic
--     registration (default 92).
--   review_confidence: minimum confidence for a review item (default 75);
--     below this, candidates are ignored.
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS semantic_ai_required BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS auto_register_confidence SMALLINT NOT NULL DEFAULT 92;
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS review_confidence SMALLINT NOT NULL DEFAULT 75;
-- Silent driver-group monitoring (default TRUE): trailer messages are analyzed
-- and registered WITHOUT any reply or reaction in the driver group. When TRUE it
-- overrides send_driver_group_confirmation and send_reaction (kept for the
-- explicit opt-out where an admin turns silent mode off). The internal Automatic
-- Updating (Test) group still receives review alerts either way.
ALTER TABLE trailer_settings ADD COLUMN IF NOT EXISTS silent_driver_group_monitoring BOOLEAN NOT NULL DEFAULT TRUE;

-- Pending trailer INSTRUCTIONS (planned/assigned pickup or drop-off) — a small
-- additive structure that keeps INSTRUCTIONS separate from COMPLETED events.
--
-- Root-cause fix: a message like "Trailer DROP OFF address / trl # VM709984 /
-- 1375 Jersey Ave …" is an assignment, NOT a completed drop-off. It must never
-- change trailer_current_status. Instead we record the planned action + planned
-- location here and wait for a later message that CONFIRMS the physical action.
-- No fake completed trailer_event is ever created just to hold an instruction.
--
-- instruction_status: pending → waiting for a completed-action confirmation;
--   confirmed → a later completed event fulfilled it (confirmed_event_id set);
--   superseded → a newer instruction/correction replaced it; cancelled → admin.
CREATE TABLE IF NOT EXISTS trailer_pending_instructions (
  id BIGSERIAL PRIMARY KEY,
  trailer_id INTEGER NULL REFERENCES trailers(id) ON DELETE SET NULL,
  trailer_unit_number TEXT NOT NULL,
  planned_action TEXT NOT NULL CHECK (planned_action IN ('pickup', 'dropoff')),
  planned_location TEXT NULL,
  planned_lat DOUBLE PRECISION NULL,
  planned_lng DOUBLE PRECISION NULL,
  driver_group_id INTEGER NULL REFERENCES groups(id) ON DELETE SET NULL,
  telegram_group_id BIGINT NULL,
  telegram_group_name TEXT NULL,
  instruction_source_message_id BIGINT NULL,
  reported_by_telegram_user_id BIGINT NULL,
  reported_by_username TEXT NULL,
  reported_by_name TEXT NULL,
  semantic_intent TEXT NULL,
  semantic_confidence SMALLINT NULL,
  ai_reason TEXT NULL,
  raw_message_text TEXT NULL,
  instruction_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (instruction_status IN ('pending', 'confirmed', 'superseded', 'cancelled')),
  confirmed_event_id BIGINT NULL,
  instruction_created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_pending_instructions_unit
  ON trailer_pending_instructions(trailer_unit_number, instruction_status);
CREATE INDEX IF NOT EXISTS idx_trailer_pending_instructions_status
  ON trailer_pending_instructions(instruction_status, instruction_created_at DESC);
-- One instruction per (group, source message, unit, action): a re-delivered
-- Telegram message never creates a duplicate. Partial so admin/manual rows
-- (no source message) are not blocked.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_trailer_pending_instructions_msg
  ON trailer_pending_instructions(telegram_group_id, instruction_source_message_id, trailer_unit_number, planned_action)
  WHERE telegram_group_id IS NOT NULL AND instruction_source_message_id IS NOT NULL;

-- ══════════════════════════════════════════════════════════════════════════
-- BOL / POD document forwarding (admin-controlled) — Settings → BOL / POD
-- ══════════════════════════════════════════════════════════════════════════
-- Runtime-editable routing for forwarding DataTruck BOL/POD documents to
-- Telegram groups. Single-row (id = 1). OFF by default: after deploy NO document
-- is forwarded to ANY group until an administrator enables the feature in the
-- admin panel. This is a NEW table — the retired bol_pod_monitor_settings table
-- (a different, removed feature) is left untouched for historical safety and is
-- NOT reused. No secrets are stored here (the bot token stays server-side).
CREATE TABLE IF NOT EXISTS bol_pod_forwarding_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  delivery_mode TEXT NOT NULL DEFAULT 'driver_group'
    CHECK (delivery_mode IN ('driver_group', 'central_group', 'both')),
  central_group_id BIGINT NULL,
  central_group_title TEXT NULL,
  central_group_validated_at TIMESTAMPTZ NULL,
  document_type_mode TEXT NOT NULL DEFAULT 'both'
    CHECK (document_type_mode IN ('bol', 'pod', 'both')),
  uncertain_document_policy TEXT NOT NULL DEFAULT 'do_not_send'
    CHECK (uncertain_document_policy IN ('do_not_send', 'central_review')),
  last_tested_at TIMESTAMPTZ NULL,
  updated_by TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO bol_pod_forwarding_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
