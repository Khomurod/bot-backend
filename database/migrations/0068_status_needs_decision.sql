-- Migration 0068: status needs decision
-- migrate:kind: backfill
--
-- The status disagreement is now TWO checks, because the two are answered by
-- different actions:
--
--   identity.status_disagreement     the BOT observed the chat's state; the
--                                    profile is copied from it automatically.
--   identity.status_needs_decision   an AI reading or an admin set it; nothing
--                                    observed it, so a person chooses Working
--                                    or Not working.
--
-- WHY. Production, 2026-10-07: the owner answered "Yes" to an AI-sourced status
-- question, the only action wired to the check refuses anything the bot did not
-- observe, and Wenze replied "Somebody fixed it first". Nobody had.
--
-- WHAT THIS MOVES. The approval-tier rows already filed under the old key —
-- open, dismissed or applied — so their history and the owner's earlier "no"
-- answers stay attached to the same driver instead of being asked again under
-- a new name. The remembered answers follow their finding. Their fingerprints
-- still match: `lib/control/fingerprint.js` hashes the new key AS the old one.
--
-- Idempotent: a second run finds nothing left under the old key with tier
-- 'approval', and never overwrites a row that already exists under the new one.

UPDATE operational_findings f
   SET check_key = 'identity.status_needs_decision', updated_at = NOW()
 WHERE f.check_key = 'identity.status_disagreement'
   AND f.tier = 'approval'
   AND NOT EXISTS (
     SELECT 1 FROM operational_findings n
      WHERE n.check_key = 'identity.status_needs_decision'
        AND n.subject_type = f.subject_type
        AND n.subject_id = f.subject_id
   );

UPDATE control_knowledge k
   SET check_key = 'identity.status_needs_decision'
 WHERE k.check_key = 'identity.status_disagreement'
   AND EXISTS (
     SELECT 1 FROM operational_findings f
      WHERE f.check_key = 'identity.status_needs_decision'
        AND f.subject_type = k.subject_type
        AND f.subject_id = k.subject_id
   )
   AND NOT EXISTS (
     SELECT 1 FROM control_knowledge n
      WHERE n.check_key = 'identity.status_needs_decision'
        AND n.subject_type = k.subject_type
        AND n.subject_id = k.subject_id
   );
