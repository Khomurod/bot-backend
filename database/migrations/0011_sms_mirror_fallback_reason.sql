-- Migration 0011: record WHY a lead was texted from the shared number
-- migrate:kind: schema
--
-- WHY: a mirror row already carries `recruiter_id` and `from_number`, so you
-- can infer that the shared number was used (recruiter_id IS NULL) — but not
-- WHY, and the why is the part an operator can act on. The reason was only
-- ever rendered into the Telegram note, which nothing can query.
--
-- The values are facebookLeadSmsSender.js's fallback reasons: unassigned,
-- unmapped_assignee, recruiter_not_configured, recruiter_auth_failed,
-- recruiter_send_failed, recruiter_number_not_on_extension,
-- recruiter_number_not_sms_capable, crm_lookup_failed, sender_lookup_failed.
-- Deliberately NOT a CHECK constraint or an enum: a new reason must not need a
-- migration, and an unrecognized value here is a logging gap, never a write
-- failure that would cost a lead its mirror.
--
-- NULL means the recruiter's own number sent it (nothing to explain) or the row
-- predates this column. Additive, idempotent, no existing column changes type,
-- no data is rewritten.

ALTER TABLE facebook_lead_sms_mirrors ADD COLUMN IF NOT EXISTS fallback_reason TEXT NULL;

COMMENT ON COLUMN facebook_lead_sms_mirrors.fallback_reason IS
  'Why this conversation is on the shared company number instead of the assigned recruiter''s. NULL when the recruiter''s own number sent it. Values are services/facebookLeadSmsSender.js fallback reasons.';
