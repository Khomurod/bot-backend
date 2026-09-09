-- Migration 0020: watching what the providers' terms actually say
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: Wenze sends structured operational data to free AI tiers. The terms of
-- those tiers are a deal that can change without anyone here noticing —
-- commercial use withdrawn, submissions starting to train models, a free tier
-- ending, a model discontinued, a region excluded. Nobody reads six providers'
-- terms pages twice a week, so nothing currently would notice, and the first
-- sign would be a feature failing or a policy already broken for months.
--
-- ─────────────────────────────────────────────────────────────────────────
-- THE DESIGN CONSTRAINT: THIS MUST NOT BECOME AN AI WORKLOAD.
--
-- The pipeline is deterministic-first, and a model is reached only for a change
-- that string handling has already PROVED is real:
--
--   conditional GET → 304? done (free) → normalise → hash → same? done
--     → line diff → immaterial? record, no alert → ONLY THEN one model call,
--       on the changed passages ALONE, never the whole document.
--
-- `lib/ai/policyText.js` and `lib/ai/policyDiff.js` are that gate, and they are
-- pure functions with no I/O precisely so the guarantee is testable: a
-- formatting-only change produces zero findings and zero AI calls.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ai_policy_sources (
  id SERIAL PRIMARY KEY,
  provider_key TEXT NOT NULL REFERENCES ai_providers(provider_key) ON DELETE CASCADE,
  url TEXT NOT NULL,
  -- What kind of page this is, so a finding can say "their PRIVACY policy
  -- changed" rather than "a page changed".
  kind TEXT NOT NULL DEFAULT 'terms'
    CHECK (kind IN ('terms', 'privacy', 'acceptable_use', 'pricing', 'model_policy', 'other')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider_key, url)
);

CREATE INDEX IF NOT EXISTS idx_ai_policy_sources_enabled
  ON ai_policy_sources (provider_key) WHERE enabled = TRUE;

-- ─────────────────────────────────────────────────────────────────────────
-- Snapshots: one row per source, overwritten in place.
--
-- One row and not a history, deliberately. Keeping every version of six
-- providers' terms pages forever would be a slowly growing pile of third-party
-- prose in a database that exists to track trucks. What is worth keeping is the
-- CURRENT text (to diff against) and the FINDINGS (what changed and why it
-- mattered) — and a finding quotes the passage that moved, so the evidence for
-- anything Wenze acted on is preserved without archiving the rest.
--
-- `etag` and `last_modified` are what make the whole feature nearly free: a 304
-- costs one request with no body and ends the check immediately.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_policy_snapshots (
  source_id INTEGER PRIMARY KEY REFERENCES ai_policy_sources(id) ON DELETE CASCADE,
  etag TEXT NULL,
  last_modified TEXT NULL,
  -- sha256 of the NORMALISED text. Unchanged hash ends the check before any
  -- diffing, and long before any model.
  content_hash TEXT NULL,
  normalised_text TEXT NULL,
  fetched_at TIMESTAMPTZ NULL,
  http_status INTEGER NULL,
  last_error TEXT NULL,
  consecutive_failures SMALLINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Findings: a change that mattered, in words a person can act on.
--
-- `severity` and `category` may be SUGGESTED by a model reading the changed
-- passages; `suspended_provider` may not. That separation is the point of this
-- table and is enforced below.
--
-- Every finding carries `quoted_passage` and `source_url` so the claim can be
-- checked against the provider's own page. An alert that says "the terms
-- changed, trust me" is not actionable; one that quotes the sentence and links
-- the page is.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_policy_findings (
  id SERIAL PRIMARY KEY,
  source_id INTEGER NULL REFERENCES ai_policy_sources(id) ON DELETE SET NULL,
  provider_key TEXT NULL,
  source_url TEXT NOT NULL,

  category TEXT NOT NULL DEFAULT 'other'
    CHECK (category IN ('commercial_use', 'trains_on_data', 'free_tier', 'retention',
                        'discontinuation', 'geography', 'other')),
  severity TEXT NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info', 'warning', 'serious')),

  -- Plain language, for somebody who has not read the terms.
  summary TEXT NOT NULL,
  what_changed TEXT NULL,
  why_it_matters TEXT NULL,
  quoted_passage TEXT NULL,

  -- Which watched topics the deterministic diff found, before any model looked.
  -- Kept separate from `category` so "what the rules matched" and "what a model
  -- called it" stay distinguishable forever.
  detected_topics TEXT[] NOT NULL DEFAULT '{}',
  changed_chars INTEGER NULL,

  -- TRUE only when an ENUMERATED deterministic rule fired. A model's opinion,
  -- however confident, can never set this — see the constraint below.
  suspended_provider BOOLEAN NOT NULL DEFAULT FALSE,
  suspension_rule TEXT NULL,

  -- Did a model help interpret this, and which one? So a reader can weigh the
  -- summary appropriately, and so a finding written with AI unavailable is
  -- still a finding rather than nothing.
  ai_assisted BOOLEAN NOT NULL DEFAULT FALSE,
  ai_model TEXT NULL,

  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ NULL,
  acknowledged_by TEXT NULL,

  -- A suspension names the rule that caused it, or it did not happen by rule.
  -- This is the schema half of "an AI opinion alone can never disable a
  -- provider": there is no way to record a suspension without naming a rule.
  CONSTRAINT ai_policy_findings_suspension_names_its_rule
    CHECK (suspended_provider = FALSE OR btrim(COALESCE(suspension_rule, '')) <> ''),
  CONSTRAINT ai_policy_findings_summary_not_blank
    CHECK (btrim(summary) <> '')
);

CREATE INDEX IF NOT EXISTS idx_ai_policy_findings_recent
  ON ai_policy_findings (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_policy_findings_unacknowledged
  ON ai_policy_findings (detected_at DESC) WHERE acknowledged_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- Watcher settings.
--
-- The Telegram destination is validated on save by
-- `services/telegramChatIdCheck.js`, which Stage 0 shipped — so this feature
-- cannot repeat the `5052301861` failure that started this whole project, where
-- a dropped minus sign silently discarded 101 alerts for months.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_policy_watcher_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- Twice weekly. Terms do not change hourly, and a watcher that polls like a
  -- health check is a watcher that gets rate-limited and switched off.
  check_days TEXT NOT NULL DEFAULT 'mon,thu',
  notify_chat_id TEXT NULL,
  notify_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  -- Only findings at or above this severity are sent to Telegram. Everything is
  -- still recorded and readable in the admin.
  notify_min_severity TEXT NOT NULL DEFAULT 'warning'
    CHECK (notify_min_severity IN ('info', 'warning', 'serious')),
  -- The deterministic suspension rules are a switch of their own. An operator
  -- who wants to be told but never overruled turns this off and keeps alerts.
  auto_suspend_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_run_at TIMESTAMPTZ NULL,
  last_run_summary JSONB NULL,
  updated_by TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO ai_policy_watcher_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- The durable outbox for alerts. Same shape as
-- `home_time_internal_alert_outbox` and `samsara video recovery`: claim with
-- FOR UPDATE SKIP LOCKED, attempts incremented at CLAIM time so a crash loop
-- stays bounded, and a bounded budget after which it stops and says so.
CREATE TABLE IF NOT EXISTS ai_policy_alert_outbox (
  id SERIAL PRIMARY KEY,
  finding_id INTEGER NOT NULL REFERENCES ai_policy_findings(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  body TEXT NOT NULL,
  attempts SMALLINT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ NULL,
  sent_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (finding_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_policy_outbox_due
  ON ai_policy_alert_outbox (next_attempt_at) WHERE sent_at IS NULL;
