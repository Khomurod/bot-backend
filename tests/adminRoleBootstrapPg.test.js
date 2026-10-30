/**
 * The boot-time super_admin grant is a FIRST-RUN BOOTSTRAP only (October 2026
 * audit), against a real PostgreSQL applying the real schema.sql — which is
 * exactly what every boot does.
 *
 * Before: baseline 022 gave super_admin to ANY role-less account on EVERY boot,
 * so an account whose roles were stripped (to lock it out) came back as super
 * administrator at the next deploy. Now it does so only while there is no
 * active super administrator at all; `seed-admin` grants the first admin's
 * role itself (`grantSuperAdminIfRoleless`).
 *
 * Requires TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createPgHarness, skipWithoutPg } = require('./helpers/pgHarness');

const POOL_PATH = require.resolve('../database/pool');

function loadRbac(harness) {
  const purge = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) purge(full);
      else if (entry.name.endsWith('.js')) delete require.cache[full];
    }
  };
  purge(path.resolve(__dirname, '../database'));
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true,
    exports: { pool: harness.pool, query: (t, v) => harness.pool.query(t, v), ping: async () => true },
  };
  return require('../database/rbac');
}

async function rolesOf(harness) {
  const { rows } = await harness.query(
    `SELECT a.username, COALESCE(string_agg(r.system_key, ',' ORDER BY r.system_key), '') AS roles
       FROM admins a
       LEFT JOIN admin_user_roles aur ON aur.admin_id = a.id
       LEFT JOIN roles r ON r.id = aur.role_id
      GROUP BY a.username ORDER BY a.username`
  );
  return Object.fromEntries(rows.map((r) => [r.username, r.roles]));
}

test('a restart no longer turns an account whose roles were stripped into a super administrator', { skip: skipWithoutPg(), timeout: 30000 }, async (t) => {
  const harness = await createPgHarness(t);
  await harness.query("INSERT INTO admins (username, password_hash) VALUES ('owner', 'x')");
  await harness.applySchemaSql();
  assert.deepEqual(await rolesOf(harness), { owner: 'super_admin' }, 'first run: the bootstrap still names the first admin');

  await harness.query("INSERT INTO admins (username, password_hash) VALUES ('stripped', 'x')");
  await harness.applySchemaSql();
  assert.deepEqual(await rolesOf(harness), { owner: 'super_admin', stripped: '' },
    'with an active super administrator, a role-less account stays role-less across a restart');
});

test('with no ACTIVE super administrator left, the bootstrap is the way back in', { skip: skipWithoutPg(), timeout: 30000 }, async (t) => {
  const harness = await createPgHarness(t);
  await harness.query("INSERT INTO admins (username, password_hash) VALUES ('owner', 'x')");
  await harness.applySchemaSql();
  await harness.query("UPDATE admins SET active = FALSE WHERE username = 'owner'");
  await harness.query("INSERT INTO admins (username, password_hash) VALUES ('rescue', 'x')");
  await harness.applySchemaSql();
  assert.equal((await rolesOf(harness)).rescue, 'super_admin');
});

test("seed-admin's explicit grant gives super_admin only to a role-less account", { skip: skipWithoutPg(), timeout: 30000 }, async (t) => {
  const harness = await createPgHarness(t);
  const rbac = loadRbac(harness);
  const office = await rbac.createRole({ displayName: 'Office Desk', permissionKeys: [] });
  const { rows: [first] } = await harness.query("INSERT INTO admins (username, password_hash) VALUES ('first', 'x') RETURNING id");
  const { rows: [clerk] } = await harness.query("INSERT INTO admins (username, password_hash) VALUES ('clerk', 'x') RETURNING id");
  await harness.query('INSERT INTO admin_user_roles (admin_id, role_id) VALUES ($1, $2)', [clerk.id, office.id]);

  assert.equal(await rbac.grantSuperAdminIfRoleless(first.id), true);
  assert.equal(await rbac.grantSuperAdminIfRoleless(first.id), false, 'a second run changes nothing');
  assert.equal(await rbac.grantSuperAdminIfRoleless(clerk.id), false, 'an account with a role keeps exactly it');
  assert.deepEqual(await rolesOf(harness), { clerk: 'custom_office_desk', first: 'super_admin' });
});
