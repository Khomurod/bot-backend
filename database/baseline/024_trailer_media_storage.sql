-- =============================================================================
-- TRAILER DEPARTMENT FILE STORAGE (no Supabase bucket required)
-- =============================================================================
-- Trailer Department uploads used to REQUIRE Supabase Storage: with no bucket
-- configured every upload threw 503, so inspection photos never stored, so the
-- required pickup photo never existed, so "Confirm Pickup and Activate" failed.
-- That chain was the reported production bug.
--
-- Storage is now an abstraction with two backends:
--   database  (default when Supabase is unconfigured) — bytes in Postgres,
--             modelled on the proven route_assignment_attachments pattern
--   supabase  (used automatically when fully configured) — unchanged behavior
--
-- The metadata model stays Supabase-compatible so files can migrate later:
-- storage_backend + bucket/object_path (supabase) or blob_id/preview_blob_id
-- (database). Existing rows predate the column and ARE Supabase-backed, which is
-- exactly what the DEFAULT below says — they keep working untouched.

-- Bytes live in their own table so ordinary metadata queries never drag BYTEA
-- across the wire. Nothing here is ever selected by a list endpoint.
CREATE TABLE IF NOT EXISTS trailer_media_blobs (
  id BIGSERIAL PRIMARY KEY,
  mime_type TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  byte_size BIGINT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  file_data BYTEA NOT NULL,
  uploaded_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE trailer_media ADD COLUMN IF NOT EXISTS storage_backend TEXT NOT NULL DEFAULT 'supabase';
ALTER TABLE trailer_media ADD COLUMN IF NOT EXISTS blob_id BIGINT NULL REFERENCES trailer_media_blobs(id) ON DELETE RESTRICT;
ALTER TABLE trailer_media ADD COLUMN IF NOT EXISTS preview_blob_id BIGINT NULL REFERENCES trailer_media_blobs(id) ON DELETE RESTRICT;

-- bucket/object_path are meaningless for a database-backed file. Dropping NOT
-- NULL only RELAXES the rule, so every existing row stays valid.
ALTER TABLE trailer_media ALTER COLUMN bucket DROP NOT NULL;
ALTER TABLE trailer_media ALTER COLUMN object_path DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trailer_media_storage_backend_check' AND conrelid = 'trailer_media'::regclass
  ) THEN
    ALTER TABLE trailer_media ADD CONSTRAINT trailer_media_storage_backend_check CHECK (
      storage_backend IN ('database', 'supabase')
    );
  END IF;
  -- Each backend must actually be able to find its own bytes.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trailer_media_backend_target_check' AND conrelid = 'trailer_media'::regclass
  ) THEN
    ALTER TABLE trailer_media ADD CONSTRAINT trailer_media_backend_target_check CHECK (
      (storage_backend = 'supabase' AND bucket IS NOT NULL AND object_path IS NOT NULL)
      OR (storage_backend = 'database' AND blob_id IS NOT NULL)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_trailer_media_blob ON trailer_media(blob_id) WHERE blob_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trailer_media_inspection ON trailer_media(inspection_id, media_type);
