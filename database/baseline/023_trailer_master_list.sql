-- =============================================================================
-- TRAILER MASTER LIST AUTHORITY
-- =============================================================================
-- `trailers` is the single authoritative master list for every part of the
-- application (tracking, department, rentals, map, AI processing, reports,
-- inspections, invoices). A trailer may join it ONLY through an approved
-- master-list import or explicit, permission-gated manual creation. A Telegram
-- message or AI detection must NEVER create one — an unknown detected number
-- becomes a trailer_unmatched_mentions review record instead.
--
-- Two independent flags decide whether a trailer is "official":
--   active         legacy soft-delete, retained as-is
--   master_status  master-list authority
-- Official  ==  active AND master_status = 'active'.
-- They are deliberately NOT mirrored onto each other: `active` keeps its legacy
-- meaning, and the master-list archive action sets both so they stay coherent.

ALTER TABLE trailers ADD COLUMN IF NOT EXISTS master_status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS master_source TEXT NOT NULL DEFAULT 'legacy_review';
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS master_import_batch_id INTEGER NULL REFERENCES trailer_import_batches(id) ON DELETE SET NULL;
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS master_verified_at TIMESTAMPTZ NULL;
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS master_verified_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS master_review_reason TEXT NULL;
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS merged_into_trailer_id INTEGER NULL REFERENCES trailers(id) ON DELETE RESTRICT;
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS archived_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL;
-- Optimistic locking: the frontend sends the version it loaded; a mismatch is a 409.
ALTER TABLE trailers ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- Each guard is scoped with conrelid, not just conname: constraint names are
-- unique per TABLE, not per database, so a bare conname check can be satisfied
-- by a same-named constraint on another schema's copy of the table and silently
-- skip creating this one.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trailers_master_status_check' AND conrelid = 'trailers'::regclass
  ) THEN
    ALTER TABLE trailers ADD CONSTRAINT trailers_master_status_check CHECK (
      master_status IN ('active', 'pending_master_review', 'archived', 'merged')
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trailers_master_source_check' AND conrelid = 'trailers'::regclass
  ) THEN
    ALTER TABLE trailers ADD CONSTRAINT trailers_master_source_check CHECK (
      master_source IN ('approved_import', 'admin_manual', 'legacy_review')
    );
  END IF;
  -- A merged trailer must name its survivor, and must never point at itself.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trailers_merged_target_check' AND conrelid = 'trailers'::regclass
  ) THEN
    ALTER TABLE trailers ADD CONSTRAINT trailers_merged_target_check CHECK (
      (master_status <> 'merged' AND merged_into_trailer_id IS NULL)
      OR (master_status = 'merged' AND merged_into_trailer_id IS NOT NULL AND merged_into_trailer_id <> id)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_trailers_master_status ON trailers(master_status);
CREATE INDEX IF NOT EXISTS idx_trailers_official ON trailers(master_status, active) WHERE master_status = 'active' AND active;

-- One-time classification of pre-authority rows from the legacy `source` column.
-- Each UPDATE is written so a row can only ever be touched ONCE, because this
-- file re-runs on every boot and must never undo a reviewer's decision:
--   * admin_manual / screenshot_import move OFF 'legacy_review', so the
--     master_source guard excludes them from then on.
--   * telegram_detected rows keep master_source='legacy_review', so they are
--     instead protected by the master_status/master_verified_at guards — once a
--     reviewer Keeps (sets master_verified_at) or Archives (changes
--     master_status) the row, it is never reclassified again.
UPDATE trailers SET master_source = 'admin_manual'
 WHERE source = 'admin_manual' AND master_source = 'legacy_review';

UPDATE trailers SET master_source = 'approved_import'
 WHERE source = 'screenshot_import' AND master_source = 'legacy_review';

-- Telegram-detected trailers were never verified by a human, so they are NOT
-- official. They keep every event and rental relationship and surface in the
-- master-list review queue for a Keep / Archive / Correct / Merge decision.
UPDATE trailers SET master_status = 'pending_master_review',
                    master_review_reason = 'Created automatically from a Telegram detection before master-list authority existed.'
 WHERE source = 'telegram_detected'
   AND master_source = 'legacy_review'
   AND master_status = 'active'
   AND master_verified_at IS NULL
   AND archived_at IS NULL;

-- Historical and corrected unit numbers. Alias matching may IDENTIFY an
-- existing canonical trailer; it must never create one.
CREATE TABLE IF NOT EXISTS trailer_aliases (
  id BIGSERIAL PRIMARY KEY,
  alias_unit_number TEXT NOT NULL,
  trailer_id INTEGER NOT NULL REFERENCES trailers(id) ON DELETE RESTRICT,
  alias_type TEXT NOT NULL CHECK (alias_type IN ('ocr_correction', 'renumber', 'merge', 'historical')),
  reason TEXT NULL,
  source_import_batch_id INTEGER NULL REFERENCES trailer_import_batches(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- An alias pointing at its own trailer's current number is meaningless.
  CHECK (alias_unit_number = UPPER(alias_unit_number))
);
-- "A single alias cannot point to two active trailers."
CREATE UNIQUE INDEX IF NOT EXISTS uniq_trailer_alias_active ON trailer_aliases(alias_unit_number) WHERE active;
CREATE INDEX IF NOT EXISTS idx_trailer_aliases_trailer ON trailer_aliases(trailer_id);

-- Telegram numbers that match no active official trailer and no active alias.
-- Evidence is preserved for review; creating a trailer from this queue requires
-- a separate, explicit, permission-gated manual action.
CREATE TABLE IF NOT EXISTS trailer_unmatched_mentions (
  id BIGSERIAL PRIMARY KEY,
  normalized_unit_number TEXT NOT NULL,
  raw_unit_number TEXT NULL,
  telegram_group_id TEXT NULL,
  telegram_group_title TEXT NULL,
  telegram_message_id BIGINT NULL,
  telegram_message_link TEXT NULL,
  sender_name TEXT NULL,
  sender_username TEXT NULL,
  message_text TEXT NULL,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ai_confidence SMALLINT NULL,
  extracted_action TEXT NULL,
  extracted_location TEXT NULL,
  evidence_media_id BIGINT NULL,
  suggested_trailer_ids JSONB NULL,
  raw_ai_result JSONB NULL,
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'linked', 'created', 'ignored', 'false_detection')),
  linked_trailer_id INTEGER NULL REFERENCES trailers(id) ON DELETE SET NULL,
  reviewed_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ NULL,
  review_note TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A resolved mention must say what it resolved to.
  CHECK (review_status <> 'linked' OR linked_trailer_id IS NOT NULL)
);
-- Re-processing the same Telegram message must not queue a duplicate mention.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_trailer_unmatched_mention_message
  ON trailer_unmatched_mentions(telegram_group_id, telegram_message_id, normalized_unit_number)
  WHERE telegram_group_id IS NOT NULL AND telegram_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trailer_unmatched_pending
  ON trailer_unmatched_mentions(review_status, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_trailer_unmatched_unit
  ON trailer_unmatched_mentions(normalized_unit_number);

-- Master-list snapshot imports reuse the existing screenshot-import staging
-- tables so their history and raw AI audit trail are preserved. import_kind
-- separates a complete official snapshot (reconciled) from the legacy
-- screenshot import (committed directly).
ALTER TABLE trailer_import_batches ADD COLUMN IF NOT EXISTS import_kind TEXT NOT NULL DEFAULT 'legacy_screenshot';
ALTER TABLE trailer_import_batches ADD COLUMN IF NOT EXISTS is_complete_snapshot BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE trailer_import_batches ADD COLUMN IF NOT EXISTS image_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trailer_import_batches ADD COLUMN IF NOT EXISTS uploaded_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE trailer_import_batches ADD COLUMN IF NOT EXISTS confirmed_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE trailer_import_batches ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ NULL;
ALTER TABLE trailer_import_batches ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ NULL;
ALTER TABLE trailer_import_batches ADD COLUMN IF NOT EXISTS duplicate_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trailer_import_batches ADD COLUMN IF NOT EXISTS conflict_count INTEGER NOT NULL DEFAULT 0;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'trailer_import_batches_kind_check') THEN
    ALTER TABLE trailer_import_batches ADD CONSTRAINT trailer_import_batches_kind_check CHECK (
      import_kind IN ('legacy_screenshot', 'master_snapshot')
    );
  END IF;
END $$;

-- Widen the status CHECK to add the staged/reconciled states the snapshot flow
-- needs. Every existing value stays valid, so this only ever relaxes the rule.
-- Guarded on the constraint DEFINITION rather than its name: re-running must be
-- a genuine no-op, because dropping and re-adding a CHECK takes an ACCESS
-- EXCLUSIVE lock and re-scans the table, and this file runs on every boot.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trailer_import_batches_status_check'
       AND conrelid = 'trailer_import_batches'::regclass
       AND pg_get_constraintdef(oid) LIKE '%reconciled%'
  ) THEN
    ALTER TABLE trailer_import_batches DROP CONSTRAINT IF EXISTS trailer_import_batches_status_check;
    ALTER TABLE trailer_import_batches ADD CONSTRAINT trailer_import_batches_status_check CHECK (
      status IN ('parsed', 'staged', 'committed', 'reconciled', 'failed')
    );
  END IF;
END $$;

ALTER TABLE trailer_import_rows ADD COLUMN IF NOT EXISTS normalized_unit_number TEXT NULL;
ALTER TABLE trailer_import_rows ADD COLUMN IF NOT EXISTS field_confidence JSONB NULL;
ALTER TABLE trailer_import_rows ADD COLUMN IF NOT EXISTS conflict_details JSONB NULL;
ALTER TABLE trailer_import_rows ADD COLUMN IF NOT EXISTS duplicate_group_key TEXT NULL;
ALTER TABLE trailer_import_rows ADD COLUMN IF NOT EXISTS source_image_index INTEGER NULL;
ALTER TABLE trailer_import_rows ADD COLUMN IF NOT EXISTS proposed_action TEXT NULL;
ALTER TABLE trailer_import_rows ADD COLUMN IF NOT EXISTS reviewer_action TEXT NULL;
ALTER TABLE trailer_import_rows ADD COLUMN IF NOT EXISTS reviewer_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE trailer_import_rows ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ NULL;
ALTER TABLE trailer_import_rows ADD COLUMN IF NOT EXISTS matched_trailer_id INTEGER NULL REFERENCES trailers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_trailer_import_rows_unit ON trailer_import_rows(normalized_unit_number);

-- Permanent audit of every master-list reconciliation decision. Append-only:
-- history survives archive and merge, and is never rewritten.
CREATE TABLE IF NOT EXISTS trailer_master_reconciliation_log (
  id BIGSERIAL PRIMARY KEY,
  batch_id INTEGER NULL REFERENCES trailer_import_batches(id) ON DELETE SET NULL,
  trailer_id INTEGER NULL REFERENCES trailers(id) ON DELETE SET NULL,
  import_row_id INTEGER NULL REFERENCES trailer_import_rows(id) ON DELETE SET NULL,
  group_name TEXT NOT NULL CHECK (group_name IN ('matched', 'new', 'missing', 'conflicting')),
  decision TEXT NOT NULL
    CHECK (decision IN ('keep_verified', 'archive', 'correct_unit', 'merge', 'create', 'update', 'skip')),
  previous_unit_number TEXT NULL,
  new_unit_number TEXT NULL,
  merged_into_trailer_id INTEGER NULL REFERENCES trailers(id) ON DELETE SET NULL,
  old_values JSONB NULL,
  new_values JSONB NULL,
  reason TEXT NULL,
  decided_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trailer_reconciliation_batch ON trailer_master_reconciliation_log(batch_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_trailer_reconciliation_trailer ON trailer_master_reconciliation_log(trailer_id, decided_at DESC);

-- Granular master-list permissions. trailer_manager receives these automatically
-- through the existing LIKE 'trailer%' grant below; super_admin through the
-- CROSS JOIN. Both are ON CONFLICT DO NOTHING, so custom role selections that
-- an administrator has already made are never destroyed.
INSERT INTO permissions (permission_key, description) VALUES
  ('trailers.verify_master', 'Verify trailers against the official master list'),
  ('trailers.archive', 'Archive a trailer out of the active master list'),
  ('trailers.merge', 'Merge duplicate trailer records'),
  ('trailer_imports.manage', 'Upload and reconcile master-list imports'),
  ('trailer_unmatched_mentions.manage', 'Review unmatched Telegram trailer mentions')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'super_admin'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'trailer_manager'
  AND (p.permission_key LIKE 'trailer%' OR p.permission_key LIKE 'trailers.%')
ON CONFLICT DO NOTHING;
