-- Migration 0008: per-recruiter SMS sender identity
-- migrate:kind: schema
--
-- WHY: every Facebook lead was texted from ONE number (+1 470-480-4679),
-- whoever Bitrix24 had actually assigned the lead to. RingCentral will not let
-- any token send an SMS from another extension's number — not even a super
-- admin's — so sending as the assigned recruiter needs (a) that recruiter's own
-- credentials and (b) a way to map a Bitrix user back to a recruiter row.
--
-- This adds both, plus the sender bookkeeping that lets a Telegram reply go
-- back out from the SAME number the driver was first texted from.
--
-- Additive and idempotent: new nullable columns, guarded indexes, one new
-- table. No existing column changes type, no data is rewritten, and every
-- statement is safe to re-run (see database/migrations/README.md).

-- ─── recruiters: Bitrix identity + OAuth credentials ───

-- The Bitrix24 user id (crm.lead.get → ASSIGNED_BY_ID) this recruiter IS.
-- Nullable: a recruiter with no Bitrix account simply never wins an assignment
-- and the shared number keeps covering their leads.
ALTER TABLE recruiters ADD COLUMN IF NOT EXISTS bitrix_user_id INTEGER NULL;

-- Partial UNIQUE: one Bitrix user maps to at most one recruiter, but any number
-- of recruiters may have no Bitrix id at all.
CREATE UNIQUE INDEX IF NOT EXISTS idx_recruiters_bitrix_user_id
  ON recruiters (bitrix_user_id) WHERE bitrix_user_id IS NOT NULL;

-- OAuth authorization-code credentials, for recruiters who onboard themselves
-- by logging in with RingCentral instead of an admin pasting a JWT.
-- REFRESH TOKENS EXPIRE (7 days) AND ROTATE ON EVERY USE, so this column is
-- rewritten by services/ringCentralOAuthService.js on each refresh — it is not
-- a write-once secret like the JWT beside it. Same AES-256-GCM envelope.
ALTER TABLE recruiters ADD COLUMN IF NOT EXISTS refresh_token_encrypted TEXT NULL;

-- Identity read back from RingCentral at authorization time. rc_extension_id is
-- what an inbound-SMS subscription filter is built from (one filter per
-- extension); the rest is for the admin panel and diagnostics.
ALTER TABLE recruiters ADD COLUMN IF NOT EXISTS rc_extension_id TEXT NULL;
ALTER TABLE recruiters ADD COLUMN IF NOT EXISTS rc_extension_number TEXT NULL;
ALTER TABLE recruiters ADD COLUMN IF NOT EXISTS rc_authorized_at TIMESTAMPTZ NULL;
ALTER TABLE recruiters ADD COLUMN IF NOT EXISTS rc_token_refreshed_at TIMESTAMPTZ NULL;

-- Last auth failure for this recruiter, or NULL when their credentials work.
-- Set when a refresh is rejected (an expired refresh token needs a NEW login),
-- so the admin panel can show "needs re-login" instead of the operator finding
-- out from leads silently falling back to the shared number.
ALTER TABLE recruiters ADD COLUMN IF NOT EXISTS rc_auth_error TEXT NULL;

-- ─── leads: who Bitrix assigned it to, and who actually texted ───

ALTER TABLE leads ADD COLUMN IF NOT EXISTS bitrix_assigned_by_id INTEGER NULL;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sms_from_number TEXT NULL;
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS sms_sender_recruiter_id INTEGER NULL
  REFERENCES recruiters(id) ON DELETE SET NULL;

-- ─── mirrors: reply from the number the driver was texted from ───

-- A driver answers the text they received. Without the sender on the mirror
-- row, that reply would go back out from the shared number and start a second
-- conversation on a number the driver has never seen.
ALTER TABLE facebook_lead_sms_mirrors
  ADD COLUMN IF NOT EXISTS recruiter_id INTEGER NULL
  REFERENCES recruiters(id) ON DELETE SET NULL;
ALTER TABLE facebook_lead_sms_mirrors ADD COLUMN IF NOT EXISTS from_number TEXT NULL;

-- ─── the RingCentral self-onboarding link ───

-- Short-lived, single-use invite a recruiter opens to authorize RingCentral.
-- The token in the URL IS the credential (same shape as
-- facebook_connect_sessions), which is why it expires and is validated on every
-- step. recruiter_id is set when an admin invites an EXISTING recruiter; left
-- NULL the callback creates the recruiter from the RingCentral extension it
-- just authorized.
CREATE TABLE IF NOT EXISTS ringcentral_connect_sessions (
  id SERIAL PRIMARY KEY,
  session_token TEXT NOT NULL UNIQUE,
  recruiter_id INTEGER NULL REFERENCES recruiters(id) ON DELETE CASCADE,
  invited_name TEXT NULL,
  created_by TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | completed | expired | error
  oauth_state TEXT NULL UNIQUE,
  last_error TEXT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_ringcentral_connect_sessions_expires
  ON ringcentral_connect_sessions (expires_at);

COMMENT ON TABLE ringcentral_connect_sessions IS
  'Short-lived, single-use links a recruiter opens to authorize RingCentral for their own number. Written by services/ringCentralConnectService.js.';
COMMENT ON COLUMN recruiters.bitrix_user_id IS
  'Bitrix24 user id (ASSIGNED_BY_ID) this recruiter is, so a lead assigned in Bitrix is texted from their number.';
COMMENT ON COLUMN recruiters.refresh_token_encrypted IS
  'AES-256-GCM RingCentral OAuth refresh token. Expires in 7 days and ROTATES on every refresh.';
