-- Migration 0031: one place to configure where Wenze's operational notices go,
-- and one durable outbox to deliver them
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY THIS EXISTS.
--
-- Every feature that needed to tell a human something invented its own way:
-- `home_time_settings.internal_clarification_group_id`,
-- `home_time_settings.completed_notify_group_id`, four columns on
-- `message_group_settings`, `config.employeeGroupId` from the environment, the
-- AI policy watcher's own destination. Five features, five destinations, five
-- message shapes, and no way for an administrator to answer "where do Wenze's
-- alerts go?" without reading the source.
--
-- It also made a whole class of failure invisible. One of those columns held a
-- chat id with the minus sign dropped, and 101 staff alerts failed with
-- "chat not found" over several months while the outbox retried, backed off,
-- gave up and told nobody.
--
-- So: ONE default destination, optional per-category overrides, and one outbox
-- whose failures are visible on /api/health like every other queue.
--
-- WHAT THIS DOES NOT TOUCH. The existing destinations keep working exactly as
-- they are. Home Time still posts its three manager notices to
-- `home_time_settings.completed_notify_group_id`, because that chat is chosen
-- for a different audience and moving it would be a behaviour change nobody
-- asked for. This is for the NEW operational categories, and for anything later
-- migrated onto it deliberately.

-- ─── Where each kind of notice goes ──────────────────────────────────────────
-- Single row, id = 1, the same shape as `samsara_settings` and
-- `home_time_settings`: NULL means "not configured", and the application layer
-- decides what that implies rather than the schema guessing.
CREATE TABLE IF NOT EXISTS operational_notification_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,

  -- The one chat every category falls back to. With this NULL nothing is sent
  -- at all, which is the correct behaviour for a fleet that has not configured
  -- it yet: a notice with nowhere to go is recorded and skipped, never guessed
  -- into somebody's chat.
  default_chat_id TEXT,

  -- Per-category overrides, `{ "fuel": "-100…", "safety_escalation": "-100…" }`.
  -- JSONB rather than a column per category because the category list lives in
  -- lib/notifications/categories.js and grows with the features; a new column
  -- per category would mean a migration every time and a schema that disagrees
  -- with the catalogue between deploys.
  category_chat_ids JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- How long a delivered notice's key blocks a repeat. Re-deriving the same
  -- condition must not re-send, but a condition that is STILL true a week later
  -- is worth saying again.
  repeat_after_hours INTEGER NOT NULL DEFAULT 168
    CHECK (repeat_after_hours BETWEEN 1 AND 8760),

  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT operational_notification_settings_single_row CHECK (id = 1)
);

INSERT INTO operational_notification_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- ─── The outbox ──────────────────────────────────────────────────────────────
-- The proven durable shape, the fourth and LAST copy of it in this repository:
-- claim with FOR UPDATE SKIP LOCKED under a lease, count the attempt at claim
-- time so a crash loop stays bounded, back off inside the failing UPDATE so the
-- delay cannot drift from the attempt count, and reach a terminal `abandoned`
-- rather than retrying forever. Every future feature routes through this one
-- instead of adding a fifth.
CREATE TABLE IF NOT EXISTS operational_notifications (
  id BIGSERIAL PRIMARY KEY,

  -- SAYING A THING ONCE, in the schema rather than in memory. A background
  -- check re-derives the same condition every few minutes and Render restarts
  -- this process several times a day, so an in-process "already sent" set is
  -- worth nothing. The enqueue is ON CONFLICT DO NOTHING against this column.
  notice_key TEXT NOT NULL UNIQUE,

  category TEXT NOT NULL,
  -- What the notice is about, so a later feature can find "everything we have
  -- said about this driver" without parsing the body.
  subject_type TEXT,
  subject_id TEXT,
  person_id INTEGER REFERENCES driver_people(id) ON DELETE SET NULL,
  group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,

  -- Resolved at enqueue time and stored, so a destination changed afterwards
  -- cannot silently redirect a notice that was already composed for one chat.
  chat_id TEXT NOT NULL,
  routed_via TEXT NOT NULL CHECK (routed_via IN ('default', 'override')),
  body TEXT NOT NULL,
  -- The facts behind it. NO signed URLs, NO credentials — lib/notifications
  -- sanitises before this is written.
  evidence_json JSONB,

  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'delivered', 'failed', 'abandoned')),
  attempts SMALLINT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_until TIMESTAMPTZ,
  last_error TEXT,
  telegram_message_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The drain's read: what is due, oldest first.
CREATE INDEX IF NOT EXISTS idx_operational_notifications_due
  ON operational_notifications (next_attempt_at)
  WHERE state = 'pending';

-- "What have we said about this driver lately", and the repeat window.
CREATE INDEX IF NOT EXISTS idx_operational_notifications_subject
  ON operational_notifications (category, subject_type, subject_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operational_notifications_person
  ON operational_notifications (person_id, created_at DESC)
  WHERE person_id IS NOT NULL;
