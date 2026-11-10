-- Migration 0099: two-pass Bitrix schema candidates and anomaly evidence
-- migrate:kind: schema
--
-- A model's first interpretation is never the active schema. The candidate is
-- catalogue metadata and aggregate counts only — no driver, deal, truck title
-- or Board row — and a structural drift may require an administrator.

CREATE TABLE IF NOT EXISTS board_bitrix_schema_candidates (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  state TEXT NOT NULL CHECK (state IN ('candidate', 'invalid')),
  mapping JSONB NULL,
  fingerprint TEXT NULL,
  source TEXT NULL,
  confidence SMALLINT NULL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 100),
  seen_count SMALLINT NOT NULL DEFAULT 0 CHECK (seen_count BETWEEN 0 AND 100),
  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  problem TEXT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE board_bitrix_schema_candidates IS
  'Catalogue-only candidate or failure for Board-Bitrix schema discovery; never driver/deal/Board data.';
