-- Migration 0048: the notification group becomes a control channel
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR.
--
-- Wenze finds things and says them into a Telegram group, and that is where the
-- conversation stops. An owner who reads "unit 001 is on three groups" has to
-- open the admin, find the finding, and act on it there — so mostly nobody
-- does, and a finding nobody answers is a finding nobody filed.
--
-- This makes the notice itself answerable: a question carries what it is about,
-- the owner REPLIES to that message in their own words, and Wenze acts on the
-- reply. Everything here exists to make that safe.
--
-- THE FOUR THINGS THAT MAKE IT SAFE, one table each:
--
--   `question_json` on the notice   what this message is about, so a reply can
--                                   be matched to a finding rather than parsed
--                                   out of free text.
--   `control_operators`             WHO may be obeyed. A Telegram group has
--                                   whoever is in it; being in the room is not
--                                   authorisation.
--   `control_replies` UNIQUE        Telegram redelivers. Without a uniqueness
--                                   guard on (chat, message) a redelivered
--                                   "yes" applies the same correction twice.
--   `control_settings`              an off switch that is one UPDATE away.

-- ── what a notice is asking, and what answered it ────────────────────────────
ALTER TABLE operational_notifications ADD COLUMN IF NOT EXISTS question_json JSONB NULL;
ALTER TABLE operational_notifications ADD COLUMN IF NOT EXISTS finding_id INTEGER NULL;
ALTER TABLE operational_notifications ADD COLUMN IF NOT EXISTS reply_to_message_id BIGINT NULL;
ALTER TABLE operational_notifications ADD COLUMN IF NOT EXISTS answered_at TIMESTAMPTZ NULL;
ALTER TABLE operational_notifications ADD COLUMN IF NOT EXISTS answered_by_reply_id INTEGER NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'operational_notifications_finding_fk'
       AND conrelid = 'operational_notifications'::regclass
  ) THEN
    ALTER TABLE operational_notifications
      ADD CONSTRAINT operational_notifications_finding_fk
      FOREIGN KEY (finding_id) REFERENCES operational_findings(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- NOT UNIQUE, deliberately. `telegram_message_id` is only unique WITHIN a chat,
-- and a redelivery or a resend can legitimately produce two rows carrying the
-- same id. The lookup takes the newest (`ORDER BY id DESC LIMIT 1`), so a
-- non-unique index is the honest shape; a UNIQUE one would fail a delivery.
CREATE INDEX IF NOT EXISTS idx_operational_notifications_tg_message
  ON operational_notifications (chat_id, telegram_message_id)
  WHERE telegram_message_id IS NOT NULL;

-- ── the switch ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS control_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- How many questions one sweep may ask. A sweep that found forty things must
  -- not deliver forty questions: the point is a channel somebody answers, and
  -- forty unanswered questions is the old silence with extra steps.
  max_questions_per_pass SMALLINT NOT NULL DEFAULT 5,
  -- How long before the same unanswered question may be asked again.
  repeat_after_hours SMALLINT NOT NULL DEFAULT 72,
  clarify_limit SMALLINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NULL,
  CONSTRAINT control_settings_single_row CHECK (id = 1),
  CONSTRAINT control_settings_cap CHECK (max_questions_per_pass BETWEEN 1 AND 20),
  CONSTRAINT control_settings_repeat CHECK (repeat_after_hours BETWEEN 1 AND 720),
  CONSTRAINT control_settings_clarify CHECK (clarify_limit BETWEEN 0 AND 3)
);
INSERT INTO control_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── who may be obeyed ────────────────────────────────────────────────────────
--
-- BEING IN THE GROUP IS NOT AUTHORISATION. A Telegram group contains whoever
-- was added to it — dispatchers, a bot, somebody's second account — and a reply
-- from any of them would otherwise apply a correction to the fleet. Seeded with
-- the one id the application already trusts (`bot/creatorMessageManager.js`), so
-- the channel works for its owner on the first boot and for nobody else.
CREATE TABLE IF NOT EXISTS control_operators (
  telegram_user_id BIGINT PRIMARY KEY,
  label TEXT NULL,
  admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  added_by TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO control_operators (telegram_user_id, label, added_by)
VALUES (2117922421, 'Owner', 'migration 0048')
ON CONFLICT (telegram_user_id) DO NOTHING;

-- ── every reply, obeyed or not ───────────────────────────────────────────────
--
-- Recorded BEFORE it is acted on and whatever the outcome, including the
-- refusals: "somebody who is not an operator replied to an operational
-- question" is exactly the sort of thing that should leave a trace.
CREATE TABLE IF NOT EXISTS control_replies (
  id SERIAL PRIMARY KEY,
  notification_id BIGINT NULL REFERENCES operational_notifications(id) ON DELETE SET NULL,
  chat_id TEXT NOT NULL,
  reply_message_id BIGINT NOT NULL,
  replied_to_message_id BIGINT NULL,
  telegram_user_id BIGINT NULL,
  authorised BOOLEAN NOT NULL DEFAULT FALSE,
  -- Capped: an operator's reply is a sentence, and storing an essay would make
  -- this table a place driver correspondence could accumulate.
  raw_text TEXT NULL,
  intent_json JSONB NULL,
  chosen_action TEXT NULL,
  outcome TEXT NOT NULL,
  finding_id INTEGER NULL,
  decision_id BIGINT NULL,
  correction_id INTEGER NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT control_replies_outcome_check CHECK (outcome IN (
    'applied', 'dismissed', 'snoozed', 'remembered', 'clarified',
    'engineering_request', 'refused', 'failed', 'no_op',
    'ignored_unauthorised', 'ignored_unknown_message', 'ignored_disabled'
  )),
  CONSTRAINT control_replies_text_len CHECK (raw_text IS NULL OR length(raw_text) <= 1000),
  -- THE REDELIVERY GUARD. Telegram can deliver the same update twice; without
  -- this a redelivered "yes" applies the same correction a second time.
  CONSTRAINT control_replies_once UNIQUE (chat_id, reply_message_id)
);

CREATE INDEX IF NOT EXISTS idx_control_replies_finding
  ON control_replies (finding_id) WHERE finding_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_control_replies_recent
  ON control_replies (created_at DESC);

COMMENT ON TABLE control_operators IS
  'Who Wenze obeys in a notification group. Being in the group is not authorisation.';
COMMENT ON TABLE control_replies IS
  'Every reply to an operational question, obeyed or refused. UNIQUE (chat_id, reply_message_id) is the redelivery guard.';
COMMENT ON COLUMN operational_notifications.question_json IS
  'What this message asks: the finding, the decision, and the actions the reply may choose from. A reply may never pick an action that is not in here.';
