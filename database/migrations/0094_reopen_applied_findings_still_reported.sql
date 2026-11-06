-- Migration 0094: reopen the applied findings the sweep is still reporting
-- migrate:kind: backfill
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- THE BUG (found 6 November 2026). A finding whose correction was applied sat
-- in `applied` for ever: `resolveClearedFindings` closed only `open` findings,
-- and `upsertFinding` reopened only `resolved` ones. So when the same
-- condition came back on the same subject — a chat's truck changing again
-- weeks later — the sweep refreshed the old `applied` row every fifteen
-- minutes and nothing ever acted on it. In production on 5–6 November:
-- unit 077 stayed Company after the board named it an owner's truck (POLVAN),
-- Javlon Turaev's record kept 555 after his profile said 011, and Felicien
-- Vernet's chat had no truck recorded after his profile said 023 — each an
-- automatic repair the owner had switched on, each refreshed and never run.
--
-- `database/operationalFindings.js` now reopens an applied finding reported
-- again after a gap of more than two sweeps — the condition came back. This
-- migration puts back the ones that recurred BEFORE the fix, whose gap is
-- already behind them and so would never be seen: still `applied`,
-- seen by a sweep in the last day, and seen at least twenty minutes after the
-- last correction that is still in force (a sweep or more later — the
-- correction did not leave the condition fixed). Reopened, they go through the
-- same gates as any open finding: the check's own switch, its cap, the
-- evidence re-read under lock. Ones not seen in the last day are left alone.
-- Nothing is deleted, and no other finding's status changes.

UPDATE operational_findings f
   SET status = 'open', resolved_at = NULL, updated_at = NOW()
 WHERE f.status = 'applied'
   AND f.last_seen_at > NOW() - INTERVAL '1 day'
   AND f.last_seen_at > COALESCE(
         (SELECT max(c.applied_at) FROM operational_corrections c
           WHERE c.finding_id = f.id AND c.reverted_at IS NULL),
         f.updated_at) + INTERVAL '20 minutes';
