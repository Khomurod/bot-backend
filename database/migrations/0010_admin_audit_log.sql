-- Migration 0010: carry the administrative audit trail into admin_audit_log
-- migrate:kind: backfill
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: database/rbac.js has always written its audit entries — admin.create,
-- admin.update, role.create, role.update — into `trailer_audit_log`, because
-- the RBAC schema shipped inside the Trailer Department's baseline segment. The
-- Trailer Department has been removed; the administrative audit trail has not,
-- and it is the only record of who granted whom which permissions.
--
-- The baseline now creates `admin_audit_log` and the code writes there. This
-- migration copies every existing row across so the trail is CONTINUOUS rather
-- than split at the rename, and advances the sequence past the copied ids so
-- the next insert cannot collide.
--
-- ADDITIVE ONLY: it inserts, it never drops. `trailer_audit_log` is left in
-- place as a retired-feature leftover; Settings → Retired feature leftovers is
-- what removes it, on an operator's explicit confirmation, once these rows are
-- safely here. Running this migration twice is a no-op (ON CONFLICT DO NOTHING
-- on the primary key).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'trailer_audit_log'
  ) THEN
    INSERT INTO admin_audit_log
      (id, admin_id, role_keys, action, entity_type, entity_id,
       old_values, new_values, reason, ip_address, created_at)
    SELECT id, admin_id, role_keys, action, entity_type, entity_id,
           old_values, new_values, reason, ip_address, created_at
      FROM trailer_audit_log
    ON CONFLICT (id) DO NOTHING;

    -- BIGSERIAL ids were copied verbatim, so the sequence must be moved past
    -- them or the next INSERT would raise a duplicate-key error.
    PERFORM setval(
      pg_get_serial_sequence('admin_audit_log', 'id'),
      GREATEST((SELECT COALESCE(MAX(id), 0) FROM admin_audit_log), 1)
    );
  END IF;
END $$;
