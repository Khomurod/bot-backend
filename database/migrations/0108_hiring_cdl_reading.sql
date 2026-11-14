-- Migration 0108: hiring cdl reading
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- READING THE CDL PHOTO OF A LEAD A PERSON ASKED FOR (owner, 14 November
-- 2026; docs/architecture/hiring-cdl-reading.md). When somebody tags the bot
-- under a lead's post, a vision model the owner chose reads what is printed on
-- the CDL, and the values go to the candidate's Bitrix contact or deal.
--
-- THE CDL'S VALUES ARE NEVER STORED HERE. Not the date of birth, not the
-- licence number, not the address: they go to Bitrix and nowhere else. These
-- two tables hold only WHERE a value goes and THAT a read happened.
--
--   hiring_cdl_field_map   the owner's mapping, one row per CDL item: which
--       Bitrix field (on the contact or on the deal) it is written to. An item
--       with no row is unmapped — its value goes into the deal's timeline
--       comment. One Bitrix field takes at most one item.
--
--   hiring_stage_cdl_reads   one row per conversation and tagging message:
--       how that read ended (written, the name differs, unsure, switched
--       off, …), who read it (provider and model), HOW MANY items were written
--       or put in the comment, and the item NAMES written — never a value.
--       A conversation with a `written` row is never read again; any other
--       ending may be tried again by a NEW tag. Deleted after 60 days, like
--       the rest of the hiring rows.

CREATE TABLE IF NOT EXISTS hiring_cdl_field_map (
  cdl_item TEXT PRIMARY KEY CHECK (cdl_item ~ '^[a-z][a-z_]{1,40}$'),
  entity TEXT NOT NULL CHECK (entity IN ('contact', 'deal')),
  field_code TEXT NOT NULL CHECK (field_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  field_label TEXT,
  field_type TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hiring_cdl_field_map_target
  ON hiring_cdl_field_map (entity, field_code);

CREATE TABLE IF NOT EXISTS hiring_stage_cdl_reads (
  id BIGSERIAL PRIMARY KEY,
  chat_id TEXT NOT NULL,
  root_message_id BIGINT NOT NULL,
  request_message_id BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'written', 'name_differs', 'unsure', 'unreadable', 'no_photo', 'off', 'no_provider',
    'no_deal', 'not_hiring', 'team', 'bitrix_refused'
  )),
  provider_key TEXT,
  model TEXT,
  items_written INTEGER NOT NULL DEFAULT 0 CHECK (items_written >= 0),
  items_in_comment INTEGER NOT NULL DEFAULT 0 CHECK (items_in_comment >= 0),
  written_items TEXT[] NOT NULL DEFAULT '{}',
  name_from_cdl BOOLEAN NOT NULL DEFAULT FALSE,
  deal_id BIGINT,
  contact_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_hiring_stage_cdl_reads_tag
  ON hiring_stage_cdl_reads (chat_id, root_message_id, request_message_id);

CREATE INDEX IF NOT EXISTS idx_hiring_stage_cdl_reads_written
  ON hiring_stage_cdl_reads (chat_id, root_message_id)
  WHERE status = 'written';

CREATE INDEX IF NOT EXISTS idx_hiring_stage_cdl_reads_created
  ON hiring_stage_cdl_reads (created_at);
