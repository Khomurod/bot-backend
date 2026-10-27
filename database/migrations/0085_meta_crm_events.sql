-- Migration 0085: meta crm events
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR. The owner, 27 October 2026: Facebook should learn which
-- leads turn into drivers. When a recruiter moves a Facebook lead's deal in
-- Bitrix (pipeline 0) to Interested / Documents / Talking to Dispatch / Sent to
-- Safety, Hired or Lost, Meta's Conversions API for CRM is told so, keyed by
-- the Meta leadgen id. See services/metaCrm/stageSync.js and
-- docs/brief/recruiting.md.
--
-- One row per (leadgen id, Meta event name): the UNIQUE key is the guarantee
-- that a lead's "Qualified" is reported to Meta once however many times its
-- deal moves between the qualified stages, and however many passes see it.
--
--   state      'pending'  recorded, not yet accepted by Meta
--              'sent'     Meta accepted it — never sent again
--              'gave_up'  failed MAX_ATTEMPTS times, or became older than
--                         Meta's seven-day window for event_time
--   event_time when the deal entered the stage (Bitrix MOVED_TIME), which is
--              what Meta is told — not when this row was written.
--
-- Not pruned: at most three rows per Facebook lead ever, the same order of
-- growth as `leads` itself.

CREATE TABLE IF NOT EXISTS meta_crm_events (
  id SERIAL PRIMARY KEY,
  leadgen_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  deal_id BIGINT NOT NULL,
  stage_id TEXT NOT NULL,
  event_time TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  CONSTRAINT meta_crm_events_lead_event_unique UNIQUE (leadgen_id, event_name),
  CONSTRAINT meta_crm_events_state_check CHECK (state IN ('pending', 'sent', 'gave_up'))
);

CREATE INDEX IF NOT EXISTS idx_meta_crm_events_pending
  ON meta_crm_events (event_time)
  WHERE state = 'pending';
