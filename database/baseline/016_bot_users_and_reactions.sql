-- TABLE: bot_users — every Telegram user the bot sees, keyed by stable
-- telegram_user_id. Originally only inline-button tappers (interactions); now
-- ALSO everyone who texts in a group the bot is in (message_count), so the
-- admin Users tab shows anyone the bot has observed. Distinct from
-- group_members (per-group membership snapshots).
CREATE TABLE IF NOT EXISTS bot_users (
  telegram_user_id BIGINT PRIMARY KEY,
  username TEXT NULL,
  first_name TEXT NULL,
  last_name TEXT NULL,
  interactions INTEGER NOT NULL DEFAULT 0,
  last_action TEXT NULL,
  last_group_id INTEGER NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_interaction_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Enrichment columns (safe, additive migrations). last_seen_chat_id is the raw
-- Telegram chat id; last_group_name a nullable snapshot of the group title;
-- message_count counts messages seen (interactions still counts button taps);
-- source is a coarse role guess (driver|dispatcher|admin|unknown). NO message
-- text is ever stored.
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS last_seen_chat_id BIGINT;
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS last_group_name TEXT;
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS language_code TEXT;
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS is_bot BOOLEAN DEFAULT FALSE;
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_users ADD COLUMN IF NOT EXISTS source TEXT;

CREATE INDEX IF NOT EXISTS idx_bot_users_last_interaction
  ON bot_users(last_interaction_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- TABLE: auto_reaction_rules — the bot automatically reacts to every message
-- posted by a chosen user with a chosen emoji. A rule identifies its target by
-- a stable telegram_user_id (when the admin picked from the seen-users list)
-- and/or a telegram_username (when typed by hand); at least one is required. A
-- user-id match wins over a username match at send time. emoji must be one of
-- the Bot-API-supported reactions (validated in the API layer).
CREATE TABLE IF NOT EXISTS auto_reaction_rules (
  id SERIAL PRIMARY KEY,
  telegram_user_id BIGINT NULL,
  telegram_username TEXT NULL,
  emoji TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  note TEXT NULL,
  created_by TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT auto_reaction_rules_identity_check
    CHECK (telegram_user_id IS NOT NULL OR telegram_username IS NOT NULL)
);

-- One rule per target identity: re-adding the same user updates their emoji
-- rather than stacking duplicate reactions. Partial uniques so a username-only
-- rule and an id-only rule never conflict on a shared NULL.
CREATE UNIQUE INDEX IF NOT EXISTS uq_auto_reaction_user_id
  ON auto_reaction_rules(telegram_user_id) WHERE telegram_user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_auto_reaction_username
  ON auto_reaction_rules(LOWER(telegram_username)) WHERE telegram_username IS NOT NULL;
