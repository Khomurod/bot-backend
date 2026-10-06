-- Migration 0065: driver chat capture
-- migrate:kind: schema
--
-- Whether Wenze records what drivers write in their groups.
--
-- WHY. Four driver-retention signals — saying they are leaving, complaints,
-- sentiment, going quiet — read `chat_logs`, and nothing had written to it
-- since the bot deliberately stopped persisting group messages. So those
-- signals answered a reassuring zero from a source that was not listening, and
-- /api/health has said so ("no driver messages are recorded") ever since.
--
-- THE OWNER DECIDED (2026-10-06): "let it read whatever it wants to read". The
-- switch is a row rather than a code change so that the decision stays the
-- owner's — turning it off is one click, not a deploy.
--
-- WHAT IS RECORDED: the text (or caption) of each message a person sends in a
-- DRIVER group. Not bots, not other chats, no media. `chat_logs` keeps 30
-- days and the hourly retention pass deletes the rest; annotations are
-- produced from it in the background.
--
-- Additive and idempotent. The column default is FALSE, as for every switch in
-- this application; the seeded row records the owner's decision explicitly.

CREATE TABLE IF NOT EXISTS driver_chat_capture_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

INSERT INTO driver_chat_capture_settings (id, enabled, updated_by)
VALUES (1, TRUE, 'owner decision 2026-10-06 (migration 0065)')
ON CONFLICT (id) DO NOTHING;

-- The annotator asks "which recent messages have no annotation yet".
CREATE INDEX IF NOT EXISTS idx_chat_logs_created_at ON chat_logs (created_at DESC);
