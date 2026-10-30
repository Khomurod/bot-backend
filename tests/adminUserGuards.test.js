'use strict';

/**
 * server/routes/adminUserGuards.js — the pure authorization guards behind
 * /api/admin/users.
 *
 * The one non-negotiable rule here is the super-administrator floor: an
 * organisation must never be able to lock itself out of its own admin panel by
 * deactivating or demoting its last active super administrator (APP_BRIEF.md §5).
 */

const test = require('node:test');
const assert = require('node:assert');
const guards = require('../server/routes/adminUserGuards');

const superAdmin = { id: 1, active: true, roles: [{ id: 10, system_key: 'super_admin' }] };
const superAdmin2 = { id: 2, active: true, roles: [{ id: 10, system_key: 'super_admin' }] };
const inactiveSuper = { id: 3, active: false, roles: [{ id: 10, system_key: 'super_admin' }] };
const dispatcher = { id: 4, active: true, roles: [{ id: 30, system_key: 'custom_dispatcher' }] };
const noRole = { id: 5, active: true, roles: [] };
const all = [superAdmin, superAdmin2, inactiveSuper, dispatcher, noRole];

test('a target that does not exist is a 404', () => {
  assert.throws(() => guards.resolveTargetOr404(all, 999), (e) => e.status === 404);
  assert.equal(guards.resolveTargetOr404(all, 4).id, 4);
});

test('only active super administrators count toward the floor', () => {
  assert.deepEqual(guards.activeSuperAdmins(all).map((u) => u.id), [1, 2]);
  assert.deepEqual(guards.activeSuperAdmins([superAdmin, inactiveSuper]).map((u) => u.id), [1]);
});

test('the last active super admin cannot be deactivated or demoted', () => {
  const oneSuper = [superAdmin, dispatcher];
  assert.throws(
    () => guards.assertSuperAdminFloor(oneSuper, superAdmin, { nextActive: false }),
    (e) => e.code === 'LAST_SUPER_ADMIN' && e.status === 409,
  );
  assert.throws(
    () => guards.assertSuperAdminFloor(oneSuper, superAdmin, { nextRoleIds: [30] }),
    (e) => e.code === 'LAST_SUPER_ADMIN' && e.status === 409,
  );
  // Keeping the super_admin role (id 10) is fine.
  assert.doesNotThrow(() => guards.assertSuperAdminFloor(oneSuper, superAdmin, { nextRoleIds: [10] }));
});

test('an inactive second super admin does not satisfy the floor', () => {
  assert.throws(
    () => guards.assertSuperAdminFloor([superAdmin, inactiveSuper], superAdmin, { nextActive: false }),
    (e) => e.code === 'LAST_SUPER_ADMIN',
  );
});

test('with two active super admins, one may be deactivated or demoted', () => {
  assert.doesNotThrow(() => guards.assertSuperAdminFloor(all, superAdmin, { nextActive: false }));
  assert.doesNotThrow(() => guards.assertSuperAdminFloor(all, superAdmin, { nextRoleIds: [30] }));
});

test('non-super-admin targets are unaffected by the floor guard', () => {
  assert.doesNotThrow(() => guards.assertSuperAdminFloor(all, dispatcher, { nextActive: false }));
  assert.doesNotThrow(() => guards.assertSuperAdminFloor(all, noRole, { nextActive: false }));
});

// ─── who may change which roles (October 2026 audit) ────────────────────────

const SUPER_ROLE = { id: 10, system_key: 'super_admin' };
const OFFICE_ROLE = { id: 30, system_key: 'custom_dispatcher' };
const superActor = { id: 1, role_keys: ['super_admin'] };
const managerActor = { id: 4, role_keys: ['custom_user_manager'] };

test('no account may be left without a role — disabling is how access is stopped', () => {
  assert.throws(
    () => guards.assertRoleChangeAllowed({ actor: superActor, target: dispatcher, selectedRoles: [] }),
    (e) => e.status === 400 && e.code === 'ROLE_REQUIRED' && /disable the account/.test(e.message),
  );
  // A request that does not touch roles is not a role change at all.
  guards.assertRoleChangeAllowed({ actor: managerActor, target: dispatcher, roleIdsGiven: false });
});

test('only a super administrator grants or removes super_admin; other roles move freely', () => {
  const superOnly = (e) => e.status === 403 && e.code === 'SUPER_ADMIN_ONLY';
  // Grant on create, grant on update, removal on update — all refused for a non-super actor.
  assert.throws(() => guards.assertRoleChangeAllowed({ actor: managerActor, selectedRoles: [SUPER_ROLE] }), superOnly);
  assert.throws(() => guards.assertRoleChangeAllowed({ actor: managerActor, target: dispatcher, selectedRoles: [SUPER_ROLE] }), superOnly);
  assert.throws(() => guards.assertRoleChangeAllowed({ actor: managerActor, target: superAdmin2, selectedRoles: [OFFICE_ROLE] }), superOnly);
  // An actor with no role keys at all is not a super administrator either.
  assert.throws(() => guards.assertRoleChangeAllowed({ actor: { id: 9 }, selectedRoles: [SUPER_ROLE] }), superOnly);
  // Allowed: a super administrator moving it, anyone moving ordinary roles,
  // and keeping super_admin where it already is.
  guards.assertRoleChangeAllowed({ actor: superActor, target: dispatcher, selectedRoles: [SUPER_ROLE] });
  guards.assertRoleChangeAllowed({ actor: superActor, target: superAdmin2, selectedRoles: [OFFICE_ROLE] });
  guards.assertRoleChangeAllowed({ actor: managerActor, target: dispatcher, selectedRoles: [OFFICE_ROLE] });
  guards.assertRoleChangeAllowed({ actor: managerActor, target: superAdmin2, selectedRoles: [SUPER_ROLE, OFFICE_ROLE] });
});

