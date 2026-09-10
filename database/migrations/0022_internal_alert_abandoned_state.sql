-- Migration 0022: a terminal state for an alert nobody will ever receive
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: 101 internal home-time alerts failed with `400: Bad Request: chat not
-- found`, every one of them at attempts = 6 = MAX_ATTEMPTS, because
-- `internal_clarification_group_id` held `5052301861` where the chat is
-- `-5052301861`. Migration 0014 fixed the id. It did not, and must not, fix the
-- pile: re-driving 98 months-old home-time alerts into a live staff chat would
-- be its own incident.
--
-- So they need somewhere to GO. `'failed'` is the outbox's "we will keep
-- looking at this" state, and it is the state `countExhaustedInternalAlerts`
-- surfaces on /api/health. Leaving them there means the queue reports 98
-- problems forever, which trains everyone to ignore the number — the exact
-- failure that let the original 101 sit unnoticed.
--
-- `'abandoned'` means: this was never delivered, nobody is going to deliver it,
-- and that is now a recorded decision rather than a backlog. It is NOT a
-- deletion — the row, its `internal_alert_last_error` and its attempt count all
-- stay exactly where they are, so what was lost is still answerable.
--
-- ─────────────────────────────────────────────────────────────────────────
-- THE MIGRATION WIDENS THE CHECK AND MOVES NOTHING.
--
-- Moving 98 rows is a decision about production data, and this repository has a
-- place for those: a Tier-1 correction, dry-run first, audited, revertible per
-- row, applied by a person from Admin → Operations. A migration that quietly
-- reclassified them would be the same silence in a new costume — and it runs
-- inside `initializeDatabase()`, where a mistake takes the application down at
-- boot (the migration-0014 lesson).
-- ─────────────────────────────────────────────────────────────────────────

-- The 0002 constraint was created inline and carries Postgres's generated name.
-- Discovered rather than assumed, so this works whatever it ended up called.
DO $$
DECLARE
  existing_name TEXT;
BEGIN
  SELECT conname INTO existing_name
    FROM pg_constraint
   WHERE conrelid = 'home_time_requests'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%internal_alert_state%'
   LIMIT 1;

  IF existing_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE home_time_requests DROP CONSTRAINT %I', existing_name);
  END IF;

  ALTER TABLE home_time_requests
    ADD CONSTRAINT home_time_requests_internal_alert_state_check
      CHECK (internal_alert_state IN ('pending', 'delivered', 'failed', 'abandoned'));
END $$;

-- The exhausted pile is read constantly (health, the sweep, the correction) and
-- is a tiny fraction of the table.
CREATE INDEX IF NOT EXISTS idx_home_time_requests_alert_exhausted
  ON home_time_requests (internal_alert_state)
  WHERE internal_alert_state IN ('failed', 'abandoned');
