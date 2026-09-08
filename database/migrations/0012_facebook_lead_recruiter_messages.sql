-- Migration 0012: an optional per-recruiter Facebook-lead auto-SMS template
-- migrate:kind: schema
--
-- WHY: the lead auto-message is one company-wide script chosen by time of day
-- (facebook_lead_auto_message_settings + _rules). Since per-recruiter sending
-- landed, the driver already hears from the recruiter Bitrix assigned the lead
-- to — but reads a message written for nobody in particular. Sofia, Kimberly
-- and Jaime each want their own opening line.
--
-- ONE OPTIONAL TEMPLATE PER RECRUITER — deliberately not a second scheduling
-- engine. When the assigned recruiter has a non-blank template it is used;
-- otherwise the existing global/time-based system decides, unchanged. That
-- keeps working hours, rule order and the outside-hours fallback exactly as
-- they are, and makes "no custom message" the safe default for every recruiter
-- that never opens the page.
--
-- recruiter_id is the primary key: at most one template per recruiter, and the
-- row disappears with the recruiter. A blank/NULL message_template means the
-- same thing as no row at all (fall back to the global system), so the admin
-- API can clear a template without a delete endpoint.

CREATE TABLE IF NOT EXISTS facebook_lead_recruiter_messages (
  recruiter_id INTEGER PRIMARY KEY REFERENCES recruiters(id) ON DELETE CASCADE,
  message_template TEXT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE facebook_lead_recruiter_messages IS
  'Optional per-recruiter override of the Facebook-lead auto-SMS text. Blank or absent means "use the global time-based Auto Message system".';
COMMENT ON COLUMN facebook_lead_recruiter_messages.is_enabled IS
  'FALSE parks a written template without deleting it — the lead falls back to the global message.';
