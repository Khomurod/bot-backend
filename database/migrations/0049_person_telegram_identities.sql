-- Migration 0049: which Telegram account belongs to which person
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR.
--
-- `driver_profiles.telegram_user_id` answers "which account do we text for this
-- CHAT". It is filled by hand, one driver at a time, and when a chat is
-- recreated the answer is lost with it — which is the same shape as every other
-- problem the person layer was built to fix. This records the account against
-- the PERSON, with a start and an end, so a driver who changes chats keeps
-- their Telegram identity and a driver who leaves has theirs closed rather than
-- overwritten.
--
-- THE HARD ANCHOR, AND THE ONE CONSTRAINT THAT MATTERS:
--
--   `uniq_person_telegram_open_account` — ONE OPEN ROW PER TELEGRAM ACCOUNT.
--   One human is behind one account at a time. Without this, two people could
--   both be "the" owner of an account and every lookup through it would pick
--   arbitrarily. A person may hold several accounts (a second phone), so the
--   constraint is on the ACCOUNT and deliberately not on the person.
--
-- WHAT IS NOT CONSTRAINED, ON PURPOSE. Nothing stops a closed row for the same
-- account existing many times over: an account that moved from one person to
-- another leaves a trail, and that trail is the point.

CREATE TABLE IF NOT EXISTS driver_person_telegram_identities (
  id SERIAL PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES driver_people(id) ON DELETE CASCADE,
  telegram_user_id BIGINT NOT NULL,

  -- A SNAPSHOT, NEVER A KEY. A username is reassignable — its owner can change
  -- it and a stranger can claim it the next day — so it is recorded for a human
  -- reading the row and is never what anything matches on.
  username_at_link TEXT NULL,

  link_source TEXT NOT NULL,
  confidence SMALLINT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ NULL,
  ended_reason TEXT NULL,
  -- WHY we believed it: the group, the candidates considered, the name that
  -- agreed. No message text, ever.
  evidence JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT driver_person_telegram_source_check CHECK (link_source IN (
    'profile_backfill', 'manual', 'member_resolution', 'board', 'import'
  )),
  CONSTRAINT driver_person_telegram_confidence_check
    CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100)
);

-- THE ANCHOR. One human per account at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_person_telegram_open_account
  ON driver_person_telegram_identities (telegram_user_id)
  WHERE ended_at IS NULL;

-- "Which accounts does this person have" — the person panel's read.
CREATE INDEX IF NOT EXISTS idx_person_telegram_person
  ON driver_person_telegram_identities (person_id)
  WHERE ended_at IS NULL;

-- ── carry across what an administrator already told us ───────────────────────
--
-- A `telegram_user_id` typed into a driver profile by a person is the strongest
-- evidence in the system — somebody looked and decided — so it seeds at 100.
--
-- GUARDED THREE WAYS, because this runs on every boot until it is applied:
--   only profiles whose chat has an OPEN person association (an orphaned chat
--   has nobody to attribute the account to);
--   only accounts not already recorded (ON CONFLICT DO NOTHING against the
--   unique index above);
--   DISTINCT ON, so two chats carrying the same account for the same person
--   insert one row rather than colliding with each other.
INSERT INTO driver_person_telegram_identities
  (person_id, telegram_user_id, username_at_link, link_source, confidence, started_at, evidence)
SELECT DISTINCT ON (p.telegram_user_id)
       pg.person_id,
       p.telegram_user_id,
       p.telegram_username,
       'profile_backfill',
       100,
       COALESCE(pg.started_at, NOW()),
       jsonb_build_object('groupId', p.group_id, 'note', 'carried from the driver profile')
  FROM driver_profiles p
  JOIN driver_person_groups pg
    ON pg.group_id = p.group_id AND pg.ended_at IS NULL
 WHERE p.telegram_user_id IS NOT NULL
 ORDER BY p.telegram_user_id, pg.started_at DESC NULLS LAST, p.group_id
ON CONFLICT DO NOTHING;

COMMENT ON TABLE driver_person_telegram_identities IS
  'Which Telegram account belongs to which person, over time. One open row per account — one human per account at a time. A username is a snapshot, never a key.';
COMMENT ON COLUMN driver_person_telegram_identities.username_at_link IS
  'What the account was called when it was linked. Reassignable, so never matched on.';
