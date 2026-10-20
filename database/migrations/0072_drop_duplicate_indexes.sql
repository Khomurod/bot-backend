-- Migration 0072: drop three indexes that duplicate a UNIQUE constraint's own index
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHAT THIS IS FOR. Part of the October 2026 cleanup the owner asked for.
-- Each index below covers exactly the same columns as a UNIQUE constraint on
-- the same table, so every write maintained two identical b-trees for one rule.
-- `database/optional-index-improvements.sql` has listed them as redundant
-- since the database review; production confirms each pair is identical
-- (same columns, no predicate, no expression).
--
--   idx_driver_profiles_group_id          = driver_profiles_group_id_unique
--   idx_group_pinned_messages_group_id    = group_pinned_messages_group_id_key
--   idx_facebook_lead_sms_mirrors_lookup  = facebook_lead_sms_mirrors_telegram_chat_id_telegram_message_key
--
-- NOTHING IS LOST, AND ON A DATABASE WITHOUT THE CONSTRAINT NOTHING IS DROPPED.
-- `CREATE TABLE IF NOT EXISTS` never adds an inline constraint to a table that
-- already existed, so on an old copy the index can be the ONLY thing keeping a
-- column unique. Each drop therefore happens only when a constraint-backed
-- unique index on exactly the same columns is present. The baseline no longer
-- creates these indexes (otherwise the next boot would rebuild them), and an
-- index is reversible: re-run its old CREATE INDEX to have it back.

DO $$
DECLARE
  pair RECORD;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('idx_driver_profiles_group_id', 'driver_profiles'),
      ('idx_group_pinned_messages_group_id', 'group_pinned_messages'),
      ('idx_facebook_lead_sms_mirrors_lookup', 'facebook_lead_sms_mirrors')
    ) AS v(index_name, table_name)
  LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_index dup
        JOIN pg_class dup_c ON dup_c.oid = dup.indexrelid
        JOIN pg_index keep ON keep.indrelid = dup.indrelid
                          AND keep.indexrelid <> dup.indexrelid
                          AND keep.indisunique
                          AND keep.indkey = dup.indkey
                          AND keep.indexprs IS NULL AND keep.indpred IS NULL
        JOIN pg_constraint k ON k.conindid = keep.indexrelid AND k.contype IN ('u', 'p')
       WHERE dup_c.relname = pair.index_name
         AND dup.indrelid = to_regclass(pair.table_name)
    ) THEN
      EXECUTE format('DROP INDEX IF EXISTS %I', pair.index_name);
    END IF;
  END LOOP;
END $$;
