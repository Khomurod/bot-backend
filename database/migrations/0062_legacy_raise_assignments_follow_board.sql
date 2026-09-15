-- Legacy dispatch-team assignments follow the Dispatcher Board again.
--
-- WHAT WENT WRONG. Migration 0058 gave `assignment_source` a default of
-- 'manual' and wrote that value onto every row that already existed, on the
-- reasoning that somebody had typed them. That reasoning was wrong in its
-- consequence: those rows were typed BEFORE the Board could place anybody, so
-- they are not decisions to overrule the Board — they are simply the old way of
-- keeping a roster. Marked 'manual' they became permanently exempt from every
-- weekly rebuild, which meant the fleet's entire existing roster could never
-- become automatic and the feature looked switched off.
--
-- HOW A REAL OVERRIDE IS TOLD APART. A person overruling the Board leaves a
-- mark: `markManualOverride` stamps `manual_override_at` and
-- `manual_override_by`. A legacy row has neither. So the timestamp is the test,
-- not the word — and this migration only touches rows that have no timestamp.
-- Anything a person actually decided is left exactly as it is.
--
-- AND ONE MORE GUARD, BECAUSE A THIRD PATH DID NOT STAMP. `setTeamDrivers`
-- (PUT /api/raise/admin/teams/:id/drivers, where an administrator types a whole
-- team's roster) relied on the column DEFAULT and so wrote 'manual' with no
-- timestamp. Rows it wrote between 0058 and now are indistinguishable from
-- legacy ones by the timestamp alone, and they ARE real decisions. So this
-- migration also refuses to touch anything modified at or after the moment 0058
-- was applied, read from the `schema_migrations` ledger: before that instant no
-- Board-aware code existed, so a row untouched since then cannot be a decision
-- about the Board. (`setTeamDrivers` now stamps in its INSERT, so the ambiguity
-- ends here rather than recurring.) If 0058 is somehow absent from the ledger
-- the window is empty and this migration does nothing, which is the safe way to
-- be wrong.
--
-- NOTHING HISTORICAL MOVES. `raise_round_picks` and `raise_round_submissions`
-- snapshot the drivers a dispatcher was actually asked about, and neither is
-- touched here. This changes only who OWNS the current roster row going
-- forward; the assignment itself, its team and its driver are unchanged, so no
-- driver moves teams as a result of this migration. The next reconciliation
-- decides that from the Board, which is the point.
--
-- Additive and idempotent: re-running matches nothing the second time.

DO $$
DECLARE
  landed TIMESTAMPTZ;
BEGIN
  -- NEVER FAIL BOOT. Migrations run inside initializeDatabase(), so a migration
  -- that throws takes the whole application down. The ledger always exists by
  -- the time forward migrations run in production, but a database built from
  -- schema.sql alone (a test harness, a scratch copy) has no such table — and
  -- "the roster was not re-owned" is a far smaller problem than "the bot did
  -- not start".
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE NOTICE '0062: no migration ledger — nothing re-owned.';
    RETURN;
  END IF;

  SELECT applied_at INTO landed
    FROM schema_migrations
   WHERE version LIKE '0058%'
   ORDER BY applied_at
   LIMIT 1;

  IF landed IS NULL THEN
    RAISE NOTICE '0062: migration 0058 is not in the ledger — nothing re-owned.';
    RETURN;
  END IF;

  UPDATE dispatch_team_drivers
     SET assignment_source = 'board'
   WHERE assignment_source = 'manual'
     AND manual_override_at IS NULL
     AND updated_at < landed;
END $$;
