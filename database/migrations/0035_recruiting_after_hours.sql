-- Migration 0035: the recruiting team's working hours, and Wenze's own state
-- for a conversation it is carrying after they go home
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY THIS EXISTS.
--
-- A Facebook lead is texted the moment it arrives, from the assigned
-- recruiter's own number. If it arrives at 9pm on a Friday, the candidate
-- answers within minutes and then hears nothing until Monday — by which time
-- they have usually applied somewhere that answered.
--
-- Wenze already knows what it is allowed to say (recruiting_knowledge, 0034).
-- What it did not know is WHEN a person is available to say it, and how far it
-- has already gone on its own.
--
-- TWO TABLES, AND THE REASON THEY ARE SEPARATE.
--
-- Working hours are a policy: one row, edited by an administrator, read on
-- every inbound message. Conversation state is per candidate and written by the
-- machine. Putting the counter in the settings row would have made every reply
-- a write to the row that governs whether replies happen at all.
--
-- THE HOURS ARE NOT THE AUTO-MESSAGE RULES.
--
-- facebook_lead_auto_message_rules already carries days and times, and reusing
-- it was the obvious move. It is the wrong table: those windows pick WHICH
-- OPENING TEMPLATE a new lead is sent, and a lead outside them still gets a
-- text. Binding "may Wenze speak for a recruiter" to the same rows would mean
-- an administrator editing a greeting silently changed who is allowed to
-- answer a candidate. They are different decisions and they stay in different
-- tables.

CREATE TABLE IF NOT EXISTS recruiting_hours_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),

  timezone TEXT NOT NULL DEFAULT 'America/Chicago',

  -- [{label, days: [1..7], start: 'HH:MM', end: 'HH:MM'}] — Monday is 1, to
  -- match Luxon and the SMALLINT[] day lists already used by the auto-message
  -- rules. EMPTY MEANS ALWAYS OPEN, which means Wenze never speaks: an
  -- unconfigured schedule must not switch a feature on.
  windows JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- The master switch, and it is OFF. Every other guard in this feature can be
  -- satisfied by data that arrives on its own; this one cannot be satisfied
  -- except by a person deciding they want it.
  ai_after_hours_enabled BOOLEAN NOT NULL DEFAULT FALSE,

  -- How far Wenze may carry one conversation before it waits for a human.
  -- A cap, not a target: a candidate with ten questions is a candidate a
  -- recruiter should be talking to.
  max_replies_per_conversation INTEGER NOT NULL DEFAULT 4
    CHECK (max_replies_per_conversation BETWEEN 0 AND 20),

  -- Nobody is helped by a text at 03:00, and a company that sends one looks
  -- like a machine. Outside this window Wenze stays silent even though the
  -- office is shut; the candidate is answered when the quiet period ends is
  -- NOT promised, because a queued reply is a reply nobody reread.
  quiet_start_local TIME NOT NULL DEFAULT '21:00',
  quiet_end_local TIME NOT NULL DEFAULT '08:00',

  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT
);

INSERT INTO recruiting_hours_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── One candidate's after-hours conversation ────────────────────────────────
--
-- Keyed on the phone number because that is what both sides of an SMS have.
-- A lead may exist twice in Bitrix and a Telegram thread may be recreated, but
-- the number the candidate texts from is the conversation.
CREATE TABLE IF NOT EXISTS recruiting_ai_conversations (
  id BIGSERIAL PRIMARY KEY,

  driver_phone TEXT NOT NULL UNIQUE,
  lead_name TEXT,

  -- Whose name Wenze is speaking in. Not a foreign key to recruiters: a
  -- recruiter row removed from the system must not delete the record of what
  -- was said on their behalf.
  recruiter_id INTEGER,

  -- Where the mirror thread lives, so a reply can be posted where the
  -- recruiter will read it in the morning.
  telegram_chat_id BIGINT,

  -- `active`      Wenze may answer, subject to every other guard.
  -- `handed_off`  a person replied after Wenze did; it is theirs again.
  -- `stopped`     a guard refused and will keep refusing (the cap, a candidate
  --               asking for a human) until somebody clears it.
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'handed_off', 'stopped')),
  stop_reason TEXT,

  replies_sent INTEGER NOT NULL DEFAULT 0,
  refusals INTEGER NOT NULL DEFAULT 0,
  last_reply_at TIMESTAMPTZ,
  last_refusal_reason TEXT,

  -- Whether the fixed "somebody will get back to you" line has gone out. Once
  -- per conversation: a candidate told twice that someone will be in touch has
  -- learned that nobody is.
  acknowledged_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recruiting_ai_conversations_active
  ON recruiting_ai_conversations (updated_at DESC)
  WHERE status = 'active';

-- ── Reading a thread by candidate, which nothing could do before ────────────
--
-- Every mirror query to date has been by (telegram_chat_id, telegram_message_id)
-- — the reply relay looking up the one message being answered. "What has this
-- candidate said to us" had no index and no caller, because nothing had ever
-- needed the conversation as a whole.
CREATE INDEX IF NOT EXISTS idx_facebook_lead_sms_mirrors_phone
  ON facebook_lead_sms_mirrors (driver_phone, created_at DESC);

-- Wenze's own answer is a responsibility an administrator can switch off, like
-- every other. It sends the candidate's own words to a provider, so it is
-- marked as raw-text; the Responsibilities screen shows that plainly.
INSERT INTO ai_capabilities (capability_key, label, sends_raw_text, has_deterministic_fallback)
VALUES (
  'recruiting_after_hours_reply',
  'Recruiting — answer a candidate outside working hours',
  TRUE,
  TRUE
)
ON CONFLICT (capability_key) DO NOTHING;
