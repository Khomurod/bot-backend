-- Migration 0045: the Dispatcher Board's connection details
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: THE BOARD IS THE AUTHORITY ON WHO IS IN WHICH TRUCK RIGHT NOW, AND
-- WENZE HAS NEVER READ IT.
--
-- Wenze knows who a person permanently is and what happened to them; the
-- Dispatcher Board — a Google Apps Script in front of the dispatchers' own
-- spreadsheet — knows today's assignment: the truck, the trailer, the status,
-- the ETA, the dispatcher, whether it is a team. Every disagreement Wenze has
-- been filing about trucks and duplicates has been an argument with a document
-- it could not see.
--
-- This migration only creates the place to put the connection. Nothing polls
-- until an administrator saves a URL and a token, and `enabled` defaults to
-- FALSE — unlike the older integrations, because there is nothing to inherit
-- from the environment here and a feature that switches itself on at deploy is
-- how an unreviewed integration starts making requests.
--
-- THE TOKEN TRAVELS IN THE QUERY STRING. That is the Apps Script's own design
-- and cannot be changed from here, so it is stored encrypted like every other
-- credential (AES-256-GCM, `lib/security/facebookCrypto`), returned to the
-- admin only as a masked last-4, and — the part that is specific to this
-- integration — every error sentence is passed through
-- `lib/security/redactUrls.stripUrls` before it reaches `last_error`, a log, an
-- API response or a finding. `last_error` therefore never contains a URL, which
-- is the only reason it is safe to keep at all.

CREATE TABLE IF NOT EXISTS dispatch_board_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  base_url TEXT NULL,
  token_encrypted TEXT NULL,
  token_last4 TEXT NULL,
  -- Floor of 60s protects the Apps Script's quota; the ceiling keeps a
  -- forgotten setting from becoming "once a day" by accident.
  poll_interval_seconds INTEGER NULL
    CHECK (poll_interval_seconds IS NULL OR poll_interval_seconds BETWEEN 60 AND 3600),
  last_poll_at TIMESTAMPTZ NULL,
  last_poll_ok BOOLEAN NULL,
  last_poll_count INTEGER NULL,
  last_poll_board_date TEXT NULL,
  last_poll_generated_at TIMESTAMPTZ NULL,
  -- URL-stripped before it is written. Never a token, never a host.
  last_error TEXT NULL,
  updated_by TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO dispatch_board_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE dispatch_board_settings IS
  'Single-row (id=1) connection for the external Dispatcher Board feed. OFF by default.';
COMMENT ON COLUMN dispatch_board_settings.last_error IS
  'Always passed through stripUrls() first — this column must never contain a URL or a token.';
