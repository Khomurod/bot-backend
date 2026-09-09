-- Migration 0018: a permission for CHANGING the fleet, distinct from seeing it
-- migrate:kind: schema
--
-- Keep it additive and idempotent (IF NOT EXISTS / ON CONFLICT). Review the
-- full diff before pushing — this repo can auto-deploy. See
-- database/migrations/README.md.
--
-- WHY: the Operations page shows findings — "these two facts of ours disagree",
-- with the evidence. Reading that is ordinary administration. APPLYING a
-- correction changes real fleet records: it closes a driver's home-time cycle,
-- or flips a driver's status. Those are not the same act, and until now the
-- application had no way to say so: `admin.full_access` is the single gate on
-- every /api route and on the whole admin nav, so anyone who could open a page
-- could do anything on it.
--
-- One permission, `operations.corrections.apply`, splits them. Read routes stay
-- on `admin.full_access`. The routes that write — apply, revert, and enabling a
-- check for auto-apply — require this one INSTEAD, not in addition, because an
-- OR against `admin.full_access` would grant it to everyone who can see the
-- page and separate nothing at all.
--
-- Nobody loses anything they have today: `super_admin` is the only built-in
-- role and it is granted this below. A custom role holding `admin.full_access`
-- will be able to read the page and not to change the fleet — which is the
-- point of adding it, not a regression.
--
-- The back-fill is NOT optional. `database/baseline/022_rbac_and_admin_users.sql`
-- CROSS JOINs every permission to super_admin at SEED time only; a permission
-- added later is granted to nobody until a statement like the second one below
-- runs. A migration that inserted only the permission row would lock every
-- existing administrator out of the feature it was written to enable.

INSERT INTO permissions (permission_key, description)
VALUES ('operations.corrections.apply',
        'Apply, revert and auto-enable operational corrections that change fleet records')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.system_key = 'super_admin'
   AND p.permission_key = 'operations.corrections.apply'
ON CONFLICT DO NOTHING;
