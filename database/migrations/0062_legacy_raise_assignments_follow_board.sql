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
-- NOTHING HISTORICAL MOVES. `raise_round_picks` and `raise_round_submissions`
-- snapshot the drivers a dispatcher was actually asked about, and neither is
-- touched here. This changes only who OWNS the current roster row going
-- forward; the assignment itself, its team and its driver are unchanged, so no
-- driver moves teams as a result of this migration. The next reconciliation
-- decides that from the Board, which is the point.
--
-- Additive and idempotent: re-running matches nothing the second time.

UPDATE dispatch_team_drivers
   SET assignment_source = 'board'
 WHERE assignment_source = 'manual'
   AND manual_override_at IS NULL;
