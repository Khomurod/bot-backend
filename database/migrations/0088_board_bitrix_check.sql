-- Migration 0088: board bitrix check
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.

--
-- WHAT THIS IS FOR. The owner, 29 October 2026: compare the Dispatcher Board —
-- the source of truth — with Bitrix24 (active drivers in pipeline 3, their
-- trucks in the "Trucks" smart process, their status) and ask about every
-- difference in the Needs-attention group, ONE AT A TIME. The owner fixes
-- Bitrix and replies "done"; Wenze checks again, confirms, and asks the next.
-- See docs/architecture/board-bitrix-check.md.
--
--   board_bitrix_settings       one row, the switch. OFF until somebody turns
--                               it on in Settings → Dispatcher Board, so the
--                               first deploy asks nobody anything by itself.
--   board_bitrix_discrepancies  one row per difference, keyed by WHAT it is
--                               about (a deal, a truck, a person), never by its
--                               values — the same question stays one question
--                               while its details change. A difference that
--                               goes away is `resolved`; if it comes back the
--                               same row is reopened, never a second row, so
--                               the table is bounded by the fleet's size.

CREATE TABLE IF NOT EXISTS board_bitrix_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by TEXT NULL
);

INSERT INTO board_bitrix_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS board_bitrix_discrepancies (
  id BIGSERIAL PRIMARY KEY,
  discrepancy_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  -- Ask order: who is missing first, then the truck, then the details.
  priority SMALLINT NOT NULL DEFAULT 50,
  -- What the Board and Bitrix said, as of the last pass (lib/boardBitrix/compare.js).
  details JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'asked', 'resolved')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Moves only when the details change: an unchanged difference is not
  -- rewritten on every pass.
  last_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  asked_at TIMESTAMPTZ NULL,
  ask_count INTEGER NOT NULL DEFAULT 0,
  -- The notice that asked it (operational_notifications.id), for threading
  -- the "fixed" confirmation under the question.
  question_notice_id BIGINT NULL,
  -- "skip": not asked again before this.
  snoozed_until TIMESTAMPTZ NULL,
  resolved_at TIMESTAMPTZ NULL,
  -- confirmed  the owner replied "done" and the re-check agreed;
  -- seen_fixed a pass found it gone with no reply.
  resolved_how TEXT NULL CHECK (resolved_how IS NULL OR resolved_how IN ('confirmed', 'seen_fixed')),
  times_reopened INTEGER NOT NULL DEFAULT 0,
  -- Telegram redelivers: a reply already handled for this question is ignored.
  last_reply_message_id TEXT NULL,
  last_reply_by_telegram_id BIGINT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ONE QUESTION OUT AT A TIME, held by the database: a timer pass and a re-check
-- after "done" that both saw nothing out cannot both ask.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_board_bitrix_one_asked
  ON board_bitrix_discrepancies ((TRUE)) WHERE state = 'asked';

CREATE INDEX IF NOT EXISTS idx_board_bitrix_discrepancies_open
  ON board_bitrix_discrepancies (priority, first_seen_at) WHERE state = 'open';

COMMENT ON TABLE board_bitrix_discrepancies IS
  'Differences between the Dispatcher Board (the source of truth) and Bitrix24, asked about one at a time. Bitrix is only read; a person fixes it.';
