-- ══════════════════════════════════════════════════════════════════════════
-- ADMIN ACCOUNTS AND ROLE-BASED ACCESS CONTROL
-- ══════════════════════════════════════════════════════════════════════════
-- Additive/idempotent. The admin account lifecycle plus the database-backed
-- permission model every authenticated request reloads from
-- (server/middleware/auth.js → database/rbac.js).
--
-- HISTORY: this substrate shipped inside the Trailer Department's baseline
-- segment, which is why the audit table it writes to was once called
-- trailer_audit_log. The department is gone; the RBAC model, its super_admin
-- role, its three company-wide permission keys and its audit trail are not.
-- The trailer roles, their permission keys and their grants are no
-- longer seeded here; the rows an existing database already has are removed by
-- Settings → Retired feature leftovers.

-- Admin account lifecycle and database-backed RBAC.
ALTER TABLE admins ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ NULL;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE admins ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS updated_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS permissions (
  id SERIAL PRIMARY KEY,
  permission_key TEXT UNIQUE NOT NULL,
  description TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS roles (
  id SERIAL PRIMARY KEY,
  system_key TEXT UNIQUE NULL,
  display_name TEXT UNIQUE NOT NULL,
  description TEXT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  updated_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_user_roles (
  admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (admin_id, role_id)
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_by_admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_id, permission_id)
);

INSERT INTO roles (system_key, display_name, description) VALUES
  ('super_admin', 'Super Administrator', 'All application permissions')
ON CONFLICT (system_key) DO NOTHING;

INSERT INTO permissions (permission_key, description) VALUES
  ('admin.full_access', 'Access legacy and company-wide administration'),
  ('users.manage', 'Manage administrator accounts'),
  ('roles.manage', 'Manage roles and permissions')
ON CONFLICT (permission_key) DO NOTHING;

-- Super administrators receive every permission. Existing admins retain their
-- former full access. System role display names remain editable; system_key is
-- the stable authorization identifier.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.system_key = 'super_admin'
ON CONFLICT DO NOTHING;

INSERT INTO admin_user_roles (admin_id, role_id)
SELECT a.id, r.id FROM admins a JOIN roles r ON r.system_key = 'super_admin'
WHERE NOT EXISTS (SELECT 1 FROM admin_user_roles aur WHERE aur.admin_id = a.id)
ON CONFLICT DO NOTHING;

-- Optimistic locking for roles: a custom-role edit that sends a stale version
-- gets a 409 instead of silently clobbering a concurrent change. Additive.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- Administrative audit log: who created or changed an admin account, a role, or
-- a role's permissions, with redacted before/after images (database/rbac.js →
-- database/adminAudit.js). These rows used to live in trailer_audit_log because
-- the RBAC schema shipped inside the Trailer Department's baseline segment;
-- migration 0010 copies them across so the trail is continuous.
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id BIGSERIAL PRIMARY KEY,
  admin_id INTEGER NULL REFERENCES admins(id) ON DELETE SET NULL,
  role_keys TEXT[] NOT NULL DEFAULT '{}',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  old_values JSONB NULL,
  new_values JSONB NULL,
  reason TEXT NULL,
  ip_address TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_entity ON admin_audit_log(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_admin ON admin_audit_log(admin_id, created_at DESC);
