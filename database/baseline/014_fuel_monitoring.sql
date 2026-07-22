-- ── Fuel Monitor: gas-station proximity reminders ──
-- When the Fuel Monitoring team posts a gas-station location into a driver
-- group, we create one "watching" row here. A background poller checks each
-- watching row against the truck's live GPS and, when the truck is within
-- radius_miles of the station, replies to the original message tagging the
-- driver, then flips the row to 'notified' (fires once). Mirrors the
-- watch/poll/claim shape of dispatch_eta_updates.
CREATE TABLE IF NOT EXISTS fuel_stop_alerts (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  telegram_group_id BIGINT NOT NULL,
  source_message_id BIGINT NOT NULL,
  station_name TEXT NULL,
  station_address TEXT NULL,
  station_lat DOUBLE PRECISION NOT NULL,
  station_lng DOUBLE PRECISION NOT NULL,
  radius_miles DOUBLE PRECISION NOT NULL DEFAULT 10,
  status TEXT NOT NULL DEFAULT 'watching',
  processing BOOLEAN NOT NULL DEFAULT FALSE,
  processing_started_at TIMESTAMP NULL,
  last_distance_miles DOUBLE PRECISION NULL,
  last_checked_at TIMESTAMP NULL,
  notified_at TIMESTAMP NULL,
  last_error TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMP NULL,
  -- ETA-based scheduling: instead of polling every watch row constantly, each
  -- row stores when it should next be evaluated (next_check_at) and the latest
  -- estimate of when the truck will reach the 10-mile boundary.
  next_check_at TIMESTAMP NULL,
  eta_minutes DOUBLE PRECISION NULL,
  eta_boundary_at TIMESTAMP NULL,
  CONSTRAINT fuel_stop_alerts_status_check CHECK (
    status IN ('watching', 'notified', 'expired', 'error')
  )
);

ALTER TABLE fuel_stop_alerts ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMP NULL;
ALTER TABLE fuel_stop_alerts ADD COLUMN IF NOT EXISTS eta_minutes DOUBLE PRECISION NULL;
ALTER TABLE fuel_stop_alerts ADD COLUMN IF NOT EXISTS eta_boundary_at TIMESTAMP NULL;

CREATE INDEX IF NOT EXISTS idx_fuel_stop_alerts_due
  ON fuel_stop_alerts(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_fuel_stop_alerts_next_check
  ON fuel_stop_alerts(status, next_check_at);
CREATE INDEX IF NOT EXISTS idx_fuel_stop_alerts_group
  ON fuel_stop_alerts(group_id, created_at DESC);

-- ── Fuel Monitor: inbox of fuel-header messages seen by the bot ──
-- Every time the bot sees a "⛽FUEL MONITORING DEPARTMENT⛽" message in a
-- company-driver group, we record it here. The detection/geocode pipeline runs
-- immediately; if it fails (transient geocode error, AI quota) the row stays
-- 'pending' and the admin "Refresh" button can retry it later. Rows that were
-- successfully turned into fuel_stop_alerts are marked 'picked_up'.
-- Note: the Telegram Bot API cannot retrieve past history, so this table is the
-- only durable record of messages the bot has observed.
CREATE TABLE IF NOT EXISTS fuel_monitor_inbox (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  telegram_group_id BIGINT NOT NULL,
  message_id BIGINT NOT NULL,
  message_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | picked_up
  alert_id INTEGER REFERENCES fuel_stop_alerts(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMP NULL,
  UNIQUE (group_id, message_id),
  CONSTRAINT fuel_monitor_inbox_status_check CHECK (status IN ('pending', 'picked_up'))
);

CREATE INDEX IF NOT EXISTS idx_fuel_monitor_inbox_status_created
  ON fuel_monitor_inbox(status, created_at DESC);
