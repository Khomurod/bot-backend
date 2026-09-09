-- Migration 0016: operational_findings — the system noticing its own contradictions
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: Wenze's features each work, and they disagree with each other. Forty-two
-- groups where `groups.active` contradicts `driver_profiles.status`. Ten unit
-- numbers on more than one active driver group. Seventy-four home-time cycles
-- opened and never closed. A chat id that pointed at nothing while an outbox
-- retried against it a hundred times. Every one of those was discoverable from
-- data already in this database, and none of them was ever surfaced.
--
-- This table is where a disagreement becomes a thing a human can see.
--
-- ─────────────────────────────────────────────────────────────────────────
-- IT IS A GENERALISATION OF duplicate_unit_reports, NOT A RIVAL TO IT.
--
-- That table has been quietly doing this job for one check family since the
-- Route Control work: upsert on (unit_number, report_type), keep first_seen_at,
-- re-open on recurrence, auto-resolve when the condition clears. It holds 48
-- rows in production, 22 of them open. The shape is proven, so it is the shape
-- copied here — widened from "a unit number" to "any subject", and from three
-- report types to a check_key.
--
-- Its rows are carried across at the bottom of this file WITH their state and
-- their original first_seen_at, so the fleet's existing detection history is not
-- reset to zero. The old table is left in place and still written by the current
-- service; a later migration retires it once the checks are folded in. Nothing
-- is dropped here.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS operational_findings (
  id SERIAL PRIMARY KEY,

  -- WHAT was checked, and WHAT it was checked about. Together they identify the
  -- condition, which is why they carry the unique constraint: a finding that is
  -- still true on the next sweep must UPDATE its row, not add another. Without
  -- that, 46 drivers past their road allowance would file 46 new rows every
  -- fifteen minutes and the page would be unreadable by lunchtime.
  check_key TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  -- TEXT because subjects are not all integers: a group id is, a unit number is
  -- not ('001' and '1' are different trucks and must not collapse).
  subject_id TEXT NOT NULL,

  title TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info', 'warning', 'serious')),

  -- What the system is allowed to DO about it, decided per check and never by a
  -- model: auto = the value is already recorded elsewhere, approval = evidence is
  -- strong but the call is a business decision, warning = a human must decide.
  tier TEXT NOT NULL DEFAULT 'warning'
    CHECK (tier IN ('auto', 'approval', 'warning')),

  -- The exact rows and values that justified this. A finding without evidence is
  -- an opinion, and this whole project exists to stop the app having those.
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- What applying it would change, as an explicit before/after. NULL for a
  -- warning-only finding, which by definition proposes nothing.
  proposed_change_json JSONB NULL,
  confidence SMALLINT NULL CHECK (confidence IS NULL OR (confidence BETWEEN 0 AND 100)),

  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'applied', 'dismissed', 'resolved', 'superseded')),

  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ NULL,

  -- Dismissal keeps its reason. "Someone closed this once" is not a record; the
  -- next operator needs to know WHY, or they will re-litigate it every sweep.
  dismissed_at TIMESTAMPTZ NULL,
  dismissed_by TEXT NULL,
  dismiss_reason TEXT NULL,

  -- A snooze is the pressure valve that keeps a real-but-known finding from
  -- training people to ignore the page. It hides the row without pretending the
  -- condition went away.
  snoozed_until TIMESTAMPTZ NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT operational_findings_subject_not_blank
    CHECK (btrim(check_key) <> '' AND btrim(subject_type) <> '' AND btrim(subject_id) <> ''),
  -- A dismissal must say why. Enforced here rather than trusted to the route,
  -- because the reason is the whole value of the record.
  CONSTRAINT operational_findings_dismissal_has_reason
    CHECK (status <> 'dismissed' OR btrim(COALESCE(dismiss_reason, '')) <> ''),
  CONSTRAINT operational_findings_identity UNIQUE (check_key, subject_type, subject_id)
);

-- The Needs Attention page's own query: open findings, worst first, newest first.
CREATE INDEX IF NOT EXISTS idx_operational_findings_open
  ON operational_findings (severity, last_seen_at DESC)
  WHERE status = 'open';

-- Per-check counts for the summary tiles, and the sweep's own resolve pass.
CREATE INDEX IF NOT EXISTS idx_operational_findings_check
  ON operational_findings (check_key, status);

CREATE INDEX IF NOT EXISTS idx_operational_findings_subject
  ON operational_findings (subject_type, subject_id);

-- ─────────────────────────────────────────────────────────────────────────
-- Carry the existing duplicate-unit history across.
--
-- ON CONFLICT DO NOTHING so a re-run (or a later squash into the baseline) is a
-- no-op, and so a live check that has already filed its own version of a row
-- wins over this one-time import.
--
-- first_seen_at is preserved deliberately: "this unit has been double-booked
-- since June" is the most useful thing the old table knows, and re-stamping it
-- to today would throw that away.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO operational_findings (
  check_key, subject_type, subject_id, title, severity, tier,
  evidence_json, status, first_seen_at, last_seen_at, resolved_at
)
SELECT
  'legacy.' || r.report_type,
  'unit',
  r.unit_number,
  COALESCE(NULLIF(btrim(r.detail), ''), r.report_type || ' on unit ' || r.unit_number),
  r.severity,
  'warning',
  jsonb_strip_nulls(jsonb_build_object(
    'reportType', r.report_type,
    'groupIds', to_jsonb(r.group_ids),
    'groupNames', to_jsonb(r.group_names),
    'groupDriverName', r.group_driver_name,
    'provider', r.provider,
    'providerDriverName', r.provider_driver_name,
    'detail', r.detail,
    'importedFrom', 'duplicate_unit_reports'
  )),
  CASE WHEN r.status = 'resolved' THEN 'resolved' ELSE 'open' END,
  r.first_seen_at,
  r.last_seen_at,
  r.resolved_at
FROM duplicate_unit_reports r
ON CONFLICT (check_key, subject_type, subject_id) DO NOTHING;
