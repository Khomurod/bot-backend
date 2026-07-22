CREATE TABLE IF NOT EXISTS employee_birthdays (
  id SERIAL PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  birthday DATE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(first_name, last_name)
);

-- Single-row settings for employee birthday wish schedule and AI message tone.
CREATE TABLE IF NOT EXISTS employee_birthday_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  timezone TEXT NOT NULL DEFAULT 'Asia/Tashkent',
  send_hour INTEGER NOT NULL DEFAULT 0,
  send_minute INTEGER NOT NULL DEFAULT 0,
  ai_instructions TEXT NOT NULL DEFAULT 'Write a warm, professional birthday message for office staff at Wenze. Be sincere and appreciative. Use different wording each time.',
  fallback_template TEXT NOT NULL DEFAULT '🎉 <b>Happy Birthday!</b> 🎂

Today we celebrate: <b>{names}</b>!

Wishing you a fantastic day and a great year ahead!

— <i>Wenze Management</i>',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (send_hour BETWEEN 0 AND 23),
  CHECK (send_minute BETWEEN 0 AND 59)
);

INSERT INTO employee_birthday_settings (id, timezone, send_hour, send_minute)
VALUES (1, 'Asia/Tashkent', 0, 0)
ON CONFLICT (id) DO NOTHING;

-- ─── service_runs ────────────────────────────────────────────────
-- Tracks one-shot daily/weekly job runs (birthday wishes, weekly reports)
-- so they are guaranteed to fire at most once per logical run key, even
-- across process restarts or multiple instances. Use INSERT ... ON CONFLICT
-- DO NOTHING with a run key like "birthday:driver:2026-05-04" to claim a run.
CREATE TABLE IF NOT EXISTS service_runs (
  id SERIAL PRIMARY KEY,
  service_name TEXT NOT NULL,
  run_key TEXT NOT NULL,
  ran_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(service_name, run_key)
);

CREATE INDEX IF NOT EXISTS idx_service_runs_ran_at
  ON service_runs(ran_at DESC);
