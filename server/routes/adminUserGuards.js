/**
 * User-administration guards — pure authorization helpers.
 *
 * These decisions are kept pure (no request, no database) so the authorization
 * matrix is unit-testable.
 *
 * HISTORY: this module also used to scope a "Trailer Manager"
 * (`trailer_users.manage` without `users.manage`) down to trailer-only
 * accounts, answering 404 rather than 403 for anything outside that scope so
 * their existence could not be inferred. The Trailer Department is gone, there
 * is no longer a partially-scoped user administrator, and `users.manage` is now
 * the single gate — so that scoping was removed rather than left as a no-op
 * filter. What remains is the guard that has nothing to do with trailers: the
 * last active super administrator can be neither deactivated nor demoted.
 */
'use strict';

function hasRole(user, systemKey) {
  return (user?.roles || []).some((r) => r.system_key === systemKey);
}

/**
 * Resolve the target user, or throw 404 when no such account exists.
 */
function resolveTargetOr404(users, id) {
  const target = users.find((u) => Number(u.id) === Number(id));
  if (!target) throw Object.assign(new Error('User not found.'), { status: 404 });
  return target;
}

/** Active super administrators in the system. */
function activeSuperAdmins(users) {
  return users.filter((u) => u.active !== false && hasRole(u, 'super_admin'));
}

/**
 * Guard the last active super administrator: it may not be deactivated or have
 * its super_admin role removed. `nextRoleIds` is the incoming role selection (or
 * undefined to keep roles), `nextActive` the incoming active flag.
 */
function assertSuperAdminFloor(users, target, { nextRoleIds, nextActive } = {}) {
  if (!hasRole(target, 'super_admin')) return;
  const supers = activeSuperAdmins(users);
  const isLast = supers.length <= 1 && supers.some((u) => Number(u.id) === Number(target.id));
  if (!isLast) return;

  const beingDeactivated = nextActive === false;
  const superRoleId = (target.roles.find((r) => r.system_key === 'super_admin') || {}).id;
  const beingDemoted = Array.isArray(nextRoleIds)
    && superRoleId != null
    && !nextRoleIds.map(Number).includes(Number(superRoleId));

  if (beingDeactivated) {
    throw Object.assign(
      new Error('The last active super administrator cannot be deactivated.'),
      { status: 409, code: 'LAST_SUPER_ADMIN' },
    );
  }
  if (beingDemoted) {
    throw Object.assign(
      new Error('The last active super administrator cannot be demoted.'),
      { status: 409, code: 'LAST_SUPER_ADMIN' },
    );
  }
}

module.exports = {
  resolveTargetOr404,
  activeSuperAdmins,
  assertSuperAdminFloor,
  hasRole,
};
