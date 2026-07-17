'use strict';

const test = require('node:test');
const assert = require('node:assert');
const scope = require('../server/routes/adminUserScope');

const req = (...perms) => ({ admin: { permissions: perms } });
const superAdmin = { id: 1, active: true, roles: [{ id: 10, system_key: 'super_admin' }] };
const superAdmin2 = { id: 2, active: true, roles: [{ id: 10, system_key: 'super_admin' }] };
const trailerMgr = { id: 3, active: true, roles: [{ id: 20, system_key: 'trailer_manager' }] };
const trailerEmp = { id: 4, active: true, roles: [{ id: 21, system_key: 'trailer_employee' }] };
const mixed = { id: 5, active: true, roles: [{ id: 20, system_key: 'trailer_manager' }, { id: 30, system_key: 'dispatcher' }] };
const noRole = { id: 6, active: true, roles: [] };
const all = [superAdmin, superAdmin2, trailerMgr, trailerEmp, mixed, noRole];

test('full admin is detected; trailer-scoped requires trailer_users.manage without users.manage', () => {
  assert.equal(scope.isFullUserAdmin(req('users.manage')), true);
  assert.equal(scope.isTrailerScopedAdmin(req('users.manage', 'trailer_users.manage')), false);
  assert.equal(scope.isTrailerScopedAdmin(req('trailer_users.manage')), true);
});

test('a trailer-only user has roles that are all trailer_-prefixed', () => {
  assert.equal(scope.isTrailerOnlyUser(trailerMgr), true);
  assert.equal(scope.isTrailerOnlyUser(trailerEmp), true);
  assert.equal(scope.isTrailerOnlyUser(mixed), false, 'a non-trailer role disqualifies');
  assert.equal(scope.isTrailerOnlyUser(superAdmin), false);
  assert.equal(scope.isTrailerOnlyUser(noRole), false, 'no roles is not in scope');
});

test('full admin sees everyone; trailer manager sees only trailer-only users', () => {
  assert.equal(scope.visibleUsers(req('users.manage'), all).length, all.length);
  const visible = scope.visibleUsers(req('trailer_users.manage'), all);
  assert.deepEqual(visible.map((u) => u.id).sort(), [3, 4]);
});

test('trailer manager targeting a super admin gets 404 (non-disclosure)', () => {
  assert.throws(
    () => scope.resolveTargetOr404(req('trailer_users.manage'), all, 1),
    (e) => e.status === 404,
  );
  // and a trailer-only user resolves fine
  assert.equal(scope.resolveTargetOr404(req('trailer_users.manage'), all, 4).id, 4);
  // full admin can target anyone
  assert.equal(scope.resolveTargetOr404(req('users.manage'), all, 1).id, 1);
});

test('the last active super admin cannot be deactivated or demoted', () => {
  const oneSuper = [superAdmin, trailerMgr];
  assert.throws(
    () => scope.assertSuperAdminFloor(oneSuper, superAdmin, { nextActive: false }),
    (e) => e.code === 'LAST_SUPER_ADMIN',
  );
  assert.throws(
    () => scope.assertSuperAdminFloor(oneSuper, superAdmin, { nextRoleIds: [20] }),
    (e) => e.code === 'LAST_SUPER_ADMIN',
  );
  // keeping the super_admin role (id 10) is fine
  assert.doesNotThrow(() => scope.assertSuperAdminFloor(oneSuper, superAdmin, { nextRoleIds: [10] }));
});

test('with two active super admins, one may be deactivated or demoted', () => {
  assert.doesNotThrow(() => scope.assertSuperAdminFloor(all, superAdmin, { nextActive: false }));
  assert.doesNotThrow(() => scope.assertSuperAdminFloor(all, superAdmin, { nextRoleIds: [20] }));
});

test('non-super-admin targets are unaffected by the floor guard', () => {
  assert.doesNotThrow(() => scope.assertSuperAdminFloor(all, trailerMgr, { nextActive: false }));
});
