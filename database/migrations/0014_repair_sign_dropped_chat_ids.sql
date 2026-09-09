-- Migration 0014: repair Telegram chat ids that lost their minus sign
-- migrate:kind: backfill
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: a Telegram group id is negative. The admin panel accepted a chat id as
-- free text and validated it only for SHAPE, so a dropped minus sign produced a
-- perfectly well-formed id for a chat that does not exist.
--
-- home_time_settings held '5052301861'. The real chat — "HR Personnel" — is
-- -5052301861. Every internal home-time alert raised against it failed with
-- "chat not found", was retried on the outbox's backoff ladder, exhausted its
-- six attempts and was marked failed. That is exactly what the outbox is
-- supposed to do; the queue was never the problem. The destination was, and
-- nothing in the application ever said so, for months.
--
-- WHAT THIS DOES, and what it deliberately does not:
--
--   It rewrites a stored chat id ONLY when the negated value is an id we
--   already hold in `groups`. That is not a guess — it is the difference
--   between "this points at nothing" and "this points at a chat we know",
--   decided from data already in this database. A positive id that matches no
--   known group is left exactly as it is: it may be a chat the bot can reach
--   that was simply never captured as a group row, and inventing a sign for it
--   would be inventing a fact.
--
--   It does not touch the alerts that already failed. Re-driving months of
--   stale home-time alerts into a live staff chat would be worse than the
--   silence was; those rows are handled separately.
--
-- Guarded so a re-run (or a later squash into the baseline) is a no-op: the
-- WHERE clause stops matching the moment the value is negative.
--
-- The route-level fix is the durable one — server/routes/homeTime/
-- settingsRoutes.js now rejects a save whose negation is a known group, naming
-- it — so this class cannot be re-entered through the admin panel.

UPDATE home_time_settings AS s
   SET internal_clarification_group_id = '-' || s.internal_clarification_group_id,
       updated_at = NOW()
 WHERE s.internal_clarification_group_id ~ '^[1-9][0-9]*$'
   AND EXISTS (
     SELECT 1 FROM groups g
      WHERE g.telegram_group_id = -1 * s.internal_clarification_group_id::BIGINT
   );

UPDATE home_time_settings AS s
   SET completed_notify_group_id = '-' || s.completed_notify_group_id,
       updated_at = NOW()
 WHERE s.completed_notify_group_id ~ '^[1-9][0-9]*$'
   AND EXISTS (
     SELECT 1 FROM groups g
      WHERE g.telegram_group_id = -1 * s.completed_notify_group_id::BIGINT
   );

-- message_group_settings stores the same kind of value in four more columns,
-- for the same reason (TEXT, to keep a -100… id exact). Same rule, same guard.
UPDATE message_group_settings AS s
   SET mileage_bonus_group_id = '-' || s.mileage_bonus_group_id
 WHERE s.mileage_bonus_group_id ~ '^[1-9][0-9]*$'
   AND EXISTS (SELECT 1 FROM groups g
                WHERE g.telegram_group_id = -1 * s.mileage_bonus_group_id::BIGINT);

UPDATE message_group_settings AS s
   SET road_bonus_group_id = '-' || s.road_bonus_group_id
 WHERE s.road_bonus_group_id ~ '^[1-9][0-9]*$'
   AND EXISTS (SELECT 1 FROM groups g
                WHERE g.telegram_group_id = -1 * s.road_bonus_group_id::BIGINT);

UPDATE message_group_settings AS s
   SET dispatch_review_group_id = '-' || s.dispatch_review_group_id
 WHERE s.dispatch_review_group_id ~ '^[1-9][0-9]*$'
   AND EXISTS (SELECT 1 FROM groups g
                WHERE g.telegram_group_id = -1 * s.dispatch_review_group_id::BIGINT);

UPDATE message_group_settings AS s
   SET raise_results_group_id = '-' || s.raise_results_group_id
 WHERE s.raise_results_group_id ~ '^[1-9][0-9]*$'
   AND EXISTS (SELECT 1 FROM groups g
                WHERE g.telegram_group_id = -1 * s.raise_results_group_id::BIGINT);
