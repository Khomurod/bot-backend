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

test('the database re-checks on locked rows, with the actor read again: a stale snapshot cannot touch a super administrator', { skip: skipWithoutPg(), timeout: 30000 }, async (t) => {
  // The route decides on snapshots read before the write — the target's, and
  // the actor's own roles from the start of the request. Either can be stale
  // by the time of the write; rbac.js locks both rows and reads them again.
  const harness = await createPgHarness(t);
  const rbac = loadRbac(harness);
  const office = await rbac.createRole({ displayName: 'Night Office', permissionKeys: [] });
  const { rows: [superRole] } = await harness.query("SELECT id FROM roles WHERE system_key = 'super_admin'");
  const add = async (name, roleId) => {
    const { rows: [a] } = await harness.query('INSERT INTO admins (username, password_hash) VALUES ($1, $2) RETURNING id', [name, 'x']);
    await harness.query('INSERT INTO admin_user_roles (admin_id, role_id) VALUES ($1, $2)', [a.id, roleId]);
    return a.id;
  };
  const boss = await add('boss', superRole.id);
  const chief = await add('chief', superRole.id);
  const manager = await add('manager', office.id);
  const clerk = await add('clerk', office.id);
  const superOnly = (e) => e.status === 403 && e.code === 'SUPER_ADMIN_ONLY';

  // An account manager: no reset of a super administrator, no super_admin grant, no role-less account.
  await assert.rejects(() => rbac.updateAdminUser(boss, { passwordHash: 'stolen', actorId: manager }), superOnly);
  await assert.rejects(() => rbac.updateAdminUser(clerk, { roleIds: [office.id, superRole.id], actorId: manager }), superOnly);
  await assert.rejects(() => rbac.createAdminUser({ username: 'new.super', passwordHash: 'x', roleIds: [superRole.id], actorId: manager }), superOnly);
  await assert.rejects(() => rbac.updateAdminUser(clerk, { roleIds: [], actorId: chief }), (e) => e.code === 'ROLE_REQUIRED');

  // A super administrator demoted after their request began: the request still
  // "knows" super_admin, the database does not — refused on update and create.
  await harness.query('DELETE FROM admin_user_roles WHERE admin_id = $1', [chief]);
  await harness.query('INSERT INTO admin_user_roles (admin_id, role_id) VALUES ($1, $2)', [chief, office.id]);
  await assert.rejects(() => rbac.updateAdminUser(boss, { passwordHash: 'stolen', actorId: chief }), superOnly);
  await assert.rejects(() => rbac.createAdminUser({ username: 'late.super', passwordHash: 'x', roleIds: [superRole.id], actorId: chief }), superOnly);
  // Disabled after the request began: changes nothing at all.
  await harness.query('UPDATE admins SET active = FALSE WHERE id = $1', [manager]);
  await assert.rejects(() => rbac.updateAdminUser(clerk, { passwordHash: 'fresh', actorId: manager }), (e) => e.code === 'ACTOR_DISABLED');

  const { rows } = await harness.query("SELECT username, password_hash FROM admins WHERE username IN ('boss', 'clerk', 'new.super', 'late.super') ORDER BY username");
  assert.deepEqual(rows, [{ username: 'boss', password_hash: 'x' }, { username: 'clerk', password_hash: 'x' }], 'nothing was written');

  // A current super administrator may; an ordinary account stays with any active account manager.
  assert.ok(await rbac.updateAdminUser(clerk, { roleIds: [office.id, superRole.id], actorId: boss }));
  assert.ok(await rbac.updateAdminUser(boss, { passwordHash: 'renewed', actorId: boss }));
});
