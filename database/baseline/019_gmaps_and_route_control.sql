-- Single-row Google Maps Platform settings + monitoring tunables.
CREATE TABLE IF NOT EXISTS gmaps_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Google Maps Platform server key (encrypted). Overrides GOOGLE_MAPS_API_KEY.
  server_api_key_encrypted TEXT NULL,
  routes_api_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  roads_api_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Optional separate Geocoding key; when empty the server key is used.
  geocoding_api_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  geocoding_api_key_encrypted TEXT NULL,
  -- Monitoring tunables.
  deviation_threshold_meters INTEGER NOT NULL DEFAULT 250
    CHECK (deviation_threshold_meters BETWEEN 10 AND 20000),
  check_interval_seconds INTEGER NOT NULL DEFAULT 300
    CHECK (check_interval_seconds BETWEEN 30 AND 3600),
  off_route_grace_checks INTEGER NOT NULL DEFAULT 3
    CHECK (off_route_grace_checks BETWEEN 1 AND 20),
  warning_cooldown_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (warning_cooldown_minutes BETWEEN 1 AND 1440),
  stale_gps_minutes INTEGER NOT NULL DEFAULT 15
    CHECK (stale_gps_minutes BETWEEN 1 AND 240),
  parked_speed_mph INTEGER NOT NULL DEFAULT 5
    CHECK (parked_speed_mph BETWEEN 0 AND 60),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO gmaps_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Auto-complete a route when the driver's fresh GPS is within this many miles of
-- the FINAL destination. Additive/idempotent; default 50 mi (see
-- services/routeControlConstants.js), recommended range 1–100. The CHECK stays
-- 0.5–100 for backward compatibility with any legacy sub-1-mile value.
ALTER TABLE gmaps_settings ADD COLUMN IF NOT EXISTS route_completion_radius_miles DOUBLE PRECISION NOT NULL DEFAULT 10
  CHECK (route_completion_radius_miles BETWEEN 0.5 AND 100);
ALTER TABLE gmaps_settings ALTER COLUMN route_completion_radius_miles SET DEFAULT 50;

-- One-shot 10 → 35 completion-radius migration. The marker column makes it run
-- exactly once even though this file executes on every boot: an untouched old
-- default of 10 becomes the new default of 35; any other (customized) value is
-- left alone. NOTE: a value of exactly 10 cannot be distinguished from a
-- deliberate choice of 10 — treating it as the old default is the documented
-- decision here (an admin can set it back to 10 afterwards and it will stick).
ALTER TABLE gmaps_settings ADD COLUMN IF NOT EXISTS completion_radius_35_migrated BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE gmaps_settings
   SET route_completion_radius_miles = 35, completion_radius_35_migrated = TRUE
 WHERE id = 1 AND completion_radius_35_migrated = FALSE AND route_completion_radius_miles = 10;
UPDATE gmaps_settings
   SET completion_radius_35_migrated = TRUE
 WHERE id = 1 AND completion_radius_35_migrated = FALSE;

-- One-shot 35 → 50 completion-radius migration (same one-run-only marker
-- pattern). The intended production radius is now 50 mi. A row still sitting on
-- the previous default of 35 is bumped to 50; any other (customized) value —
-- including a deliberate 35 the admin later re-selects — is left untouched.
-- Additive/idempotent: safe to re-run on every boot.
ALTER TABLE gmaps_settings ADD COLUMN IF NOT EXISTS completion_radius_50_migrated BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE gmaps_settings
   SET route_completion_radius_miles = 50, completion_radius_50_migrated = TRUE
 WHERE id = 1 AND completion_radius_50_migrated = FALSE AND route_completion_radius_miles = 35;
UPDATE gmaps_settings
   SET completion_radius_50_migrated = TRUE
 WHERE id = 1 AND completion_radius_50_migrated = FALSE;

-- One assigned route per row. group_id ties it to a driver group so the monitor
-- can resolve that driver's live GPS (via the same resolver as /location).
CREATE TABLE IF NOT EXISTS route_assignments (
  id SERIAL PRIMARY KEY,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
  driver_profile_id INTEGER NULL,
  driver_label TEXT NULL,
  unit_number TEXT NULL,
  original_url TEXT NOT NULL,
  origin_text TEXT NULL,
  destination_text TEXT NULL,
  waypoints JSONB NOT NULL DEFAULT '[]'::jsonb,
  origin_lat DOUBLE PRECISION NULL,
  origin_lng DOUBLE PRECISION NULL,
  destination_lat DOUBLE PRECISION NULL,
  destination_lng DOUBLE PRECISION NULL,
  -- Google encoded polyline for the computed route (NULL until computed).
  encoded_polyline TEXT NULL,
  distance_meters DOUBLE PRECISION NULL,
  duration_seconds DOUBLE PRECISION NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'cancelled')),
  assigned_by TEXT NULL,
  -- Live monitoring state.
  last_checked_at TIMESTAMPTZ NULL,
  last_latitude DOUBLE PRECISION NULL,
  last_longitude DOUBLE PRECISION NULL,
  last_deviation_meters DOUBLE PRECISION NULL,
  last_check_result TEXT NULL,
  consecutive_off_route INTEGER NOT NULL DEFAULT 0,
  last_notification_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Where the assignment came from: 'admin' (Route Control page) or 'telegram'
-- (a dispatcher sent a Google Maps route link in the driver group). The
-- Telegram origin also records the sender's numeric id and the triggering
-- message id — the (chat, message) pair is a restart-safe dedupe key so the
-- same route message is never processed twice.
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'admin';
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS assigned_by_user_id BIGINT NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS telegram_chat_id BIGINT NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS telegram_message_id BIGINT NULL;
-- Admin → "Send route message to driver group" delivery tracking. sent_at is the
-- last successful send; message_id the Telegram message id (for a link/edit);
-- sent_by the admin username/name that triggered it.
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS driver_group_message_sent_at TIMESTAMPTZ NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS driver_group_message_id BIGINT NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS driver_group_message_sent_by TEXT NULL;

-- Tracking start controls. `status` stays the route LIFECYCLE (active/completed/
-- cancelled); `tracking_status` is the MONITORING state layered on top:
--   pending → the start condition has not been met yet (mode decides which)
--   active  → the monitor compares live GPS against the route
-- Existing rows default to active/immediate so the migration changes nothing
-- for routes that are already being monitored. tracking_hold_reason is a short
-- machine-readable reason shown in the admin UI while pending
-- (waiting_for_message | waiting_for_time | waiting_for_location).
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_start_mode TEXT NOT NULL DEFAULT 'immediate';
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_start_at TIMESTAMPTZ NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_started_at TIMESTAMPTZ NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_start_lat DOUBLE PRECISION NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_start_lng DOUBLE PRECISION NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_start_location_text TEXT NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_start_radius_miles DOUBLE PRECISION NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS tracking_hold_reason TEXT NULL;

-- Auto-completion. When the driver's fresh GPS enters the completion radius
-- around the FINAL destination (destination_lat/destination_lng), the monitor
-- flips status to 'completed', records where/when/how far, and stops monitoring
-- permanently. These columns are additive/idempotent; NULL on every existing row.
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS completion_latitude DOUBLE PRECISION NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS completion_longitude DOUBLE PRECISION NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS completion_distance_meters DOUBLE PRECISION NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS completion_reason TEXT NULL;

-- Completion diagnostics (why a route is / is not completing) + screenshot send
-- reporting. Written by the monitor on every completion check so the Admin
-- panel can show the live distance to the final destination and a
-- machine-readable blocked reason (e.g. DESTINATION_COORDINATES_MISSING,
-- LIVE_GPS_STALE, OUTSIDE_COMPLETION_RADIUS). All additive/idempotent.
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS last_completion_check_at TIMESTAMPTZ NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS last_destination_distance_meters DOUBLE PRECISION NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS completion_blocked_reason TEXT NULL;
-- Bounded destination-coordinate repair bookkeeping (never retried every tick).
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS destination_repair_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS destination_repair_last_at TIMESTAMPTZ NULL;
-- How the last driver-group route message went out (photo | photo+text | text)
-- and the last screenshot delivery error (NULL when the screenshot was sent or
-- there was none) — lets the Admin panel say "Sent as text only" truthfully.
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS driver_group_message_via TEXT NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS screenshot_send_error TEXT NULL;

-- One route delivery can be MORE than one Telegram message (a photo plus a
-- separate long-text message). To later EDIT every part in place (replace the
-- screenshot / edit the text) without posting new messages, store the ordered
-- list of Telegram messages that make up the delivery:
--   [{ "message_id": 71, "kind": "photo" }, { "message_id": 72, "kind": "text" }]
-- driver_group_messages is the authoritative record used for in-place editing;
-- it survives restart/redeploy/logout because it lives in the DB, not memory.
-- Legacy rows (NULL here) are reconstructed from driver_group_message_id +
-- driver_group_message_via. driver_group_message_edited_at / _edit_error record
-- the last in-place edit outcome so the admin panel can report it truthfully.
-- All additive/idempotent; NULL on every existing row.
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS driver_group_messages JSONB NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS driver_group_message_edited_at TIMESTAMPTZ NULL;
ALTER TABLE route_assignments ADD COLUMN IF NOT EXISTS driver_group_message_edit_error TEXT NULL;

-- Route screenshots (admin-attached images sent with the driver-group route
-- message). A SEPARATE table so no existing `SELECT r.*` query ever drags image
-- bytes into list views; bytes are only read by the dedicated fetch used for
-- Telegram sends and the auth-gated preview endpoint. One screenshot per
-- assignment (replaced on re-upload).
CREATE TABLE IF NOT EXISTS route_assignment_attachments (
  id SERIAL PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES route_assignments(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'route_screenshot',
  mime_type TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  file_data BYTEA NOT NULL,
  uploaded_by TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_route_assignment_attachments_assignment
  ON route_assignment_attachments(assignment_id, kind);

-- Enforce ONE screenshot per (assignment, kind) so replacement can be a single
-- atomic UPSERT (a failed replacement can never destroy the stored screenshot,
-- and two concurrent uploads can never leave duplicates). The DELETE below
-- clears any pre-constraint duplicates (keeps the newest row) and is a no-op on
-- every later boot.
DELETE FROM route_assignment_attachments a
 USING route_assignment_attachments b
 WHERE a.assignment_id = b.assignment_id AND a.kind = b.kind AND a.id < b.id;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_route_assignment_attachment
  ON route_assignment_attachments(assignment_id, kind);

CREATE INDEX IF NOT EXISTS idx_route_assignments_active
  ON route_assignments(status, updated_at DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_route_assignments_group
  ON route_assignments(group_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_route_assignments_telegram_message
  ON route_assignments(telegram_chat_id, telegram_message_id)
  WHERE telegram_chat_id IS NOT NULL AND telegram_message_id IS NOT NULL;

-- Audit trail of monitoring checks + notifications for one assignment.
CREATE TABLE IF NOT EXISTS route_monitor_events (
  id SERIAL PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES route_assignments(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  result TEXT NULL,
  latitude DOUBLE PRECISION NULL,
  longitude DOUBLE PRECISION NULL,
  deviation_meters DOUBLE PRECISION NULL,
  detail TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_route_monitor_events_assignment
  ON route_monitor_events(assignment_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- Duplicate unit-number reports (Samsara / provider ↔ driver-group mismatches).
--
-- When two active driver groups carry the same truck/unit number, or a provider
-- vehicle label lists a different driver than the group it is matched to, the bot
-- can pick the wrong truck in /location and live tracking. A 15-minute sanity
-- check records these situations here for admin review instead of guessing. Rows
-- are keyed by (unit_number, report_type) and reopened/refreshed each run; issues
-- that disappear are auto-resolved.
CREATE TABLE IF NOT EXISTS duplicate_unit_reports (
  id SERIAL PRIMARY KEY,
  unit_number TEXT NOT NULL,
  -- duplicate_unit  = same unit across >1 active driver group
  -- name_mismatch   = provider vehicle label's driver ≠ the group's driver
  -- ambiguous_match = duplicate unit AND no confident driver-name winner
  report_type TEXT NOT NULL CHECK (report_type IN ('duplicate_unit', 'name_mismatch', 'ambiguous_match')),
  group_ids INTEGER[] NOT NULL DEFAULT '{}',
  group_names TEXT[] NOT NULL DEFAULT '{}',
  group_driver_name TEXT,
  provider TEXT,
  provider_driver_name TEXT,
  detail TEXT,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'serious')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ NULL,
  UNIQUE (unit_number, report_type)
);

CREATE INDEX IF NOT EXISTS idx_duplicate_unit_reports_open
  ON duplicate_unit_reports(status, last_seen_at DESC) WHERE status = 'open';
