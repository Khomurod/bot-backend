/**
 * PostgreSQL integration — custom role creation and optimistic locking
 * (blockers §11 + §20 for roles).
 *
 * Proves createRole assigns a unique custom_* system key, rejects reserved
 * keys, and that updateRole enforces the version and still protects the
 * super-admin role.
 *
 * Requires TEST_DATABASE_URL.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { createTrailerPgHarness, skipWithoutPg } = require('./helpers/trailerPgHarness');

const POOL_PATH = require.resolve('../database/pool');

function loadRbac(harness) {
  const dbDir = path.resolve(__dirname, '../database');
  const purge = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) purge(full);
      else if (entry.name.endsWith('.js')) delete require.cache[full];
    }
  };
  purge(dbDir);
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true,
    exports: { pool: harness.pool, query: (t, v) => harness.pool.query(t, v), ping: async () => true },
  };
  return require('../database/rbac');
}

test('createRole assigns a unique custom_* key and de-duplicates', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const rbac = loadRbac(harness);

  const a = await rbac.createRole({ displayName: 'Yard Supervisor', permissionKeys: [] });
  assert.equal(a.system_key, 'custom_yard_supervisor');
  assert.equal(a.version, 1);

  // A different display name that slugifies to the same base gets a suffixed
  // key, never a NULL or a clash. (display_name itself is unique, so the names
  // must differ.)
  const b = await rbac.createRole({ displayName: 'Yard-Supervisor', permissionKeys: [] });
  assert.equal(b.system_key, 'custom_yard_supervisor_2');
});

test('createRole refuses a reserved system key', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const rbac = loadRbac(harness);
  await assert.rejects(
    () => rbac.createRole({ displayName: 'Sneaky', permissionKeys: [], systemKey: 'super_admin' }),
    (e) => e.code === 'ROLE_KEY_RESERVED' && e.status === 409,
  );
});

test('createRole attaches the requested permissions', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const rbac = loadRbac(harness);
  // Two permissions that the seed schema defines.
  const perms = await harness.query("SELECT permission_key FROM permissions LIMIT 2");
  const keys = perms.rows.map((r) => r.permission_key);
  const role = await rbac.createRole({ displayName: 'Limited Ops', permissionKeys: keys });
  const linked = await harness.query(
    `SELECT p.permission_key FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1`, [role.id],
  );
  assert.deepEqual(linked.rows.map((r) => r.permission_key).sort(), [...keys].sort());
});

test('updateRole enforces optimistic locking', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const rbac = loadRbac(harness);
  const role = await rbac.createRole({ displayName: 'Editable Role', permissionKeys: [] });

  // A stale version is rejected with 409.
  await assert.rejects(
    () => rbac.updateRole(role.id, { description: 'x', version: role.version + 5 }),
    (e) => e.code === 'VERSION_CONFLICT' && e.status === 409,
  );

  // The correct version succeeds and bumps the version.
  const updated = await rbac.updateRole(role.id, { description: 'now described', version: role.version });
  assert.ok(updated);
  const row = await harness.query('SELECT version, description FROM roles WHERE id=$1', [role.id]);
  assert.equal(row.rows[0].version, role.version + 1);
  assert.equal(row.rows[0].description, 'now described');
});

test('updateRole still protects the super administrator role', {
  skip: skipWithoutPg(), timeout: 30000,
}, async (t) => {
  const harness = await createTrailerPgHarness(t);
  const rbac = loadRbac(harness);
  const sa = await harness.query("SELECT id, version FROM roles WHERE system_key='super_admin'");
  await assert.rejects(
    () => rbac.updateRole(sa.rows[0].id, { active: false, version: sa.rows[0].version }),
    (e) => e.status === 409,
  );
});
