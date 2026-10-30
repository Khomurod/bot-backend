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

/**
 * Who may change which roles (October 2026 audit).
 *
 * NO ACCOUNT WITHOUT A ROLE. The database still hands `super_admin` to a
 * role-less account at boot when there is no active super administrator (the
 * first-run bootstrap, baseline 022), so a role-less account is a trap: until
 * October 2026 that grant ran for ANY role-less account, and stripping
 * someone's roles to lock them out made them super administrator at the next
 * deploy. To stop someone signing in, disable the account.
 *
 * ONLY A SUPER ADMINISTRATOR MOVES THE SUPER ADMINISTRATOR ROLE. Otherwise
 * `users.manage` alone could make anyone — the holder included — super
 * administrator, and a role meant to manage accounts would be every permission
 * in disguise.
 *
 * `selectedRoles` are the catalog rows for the requested role ids;
 * `roleIdsGiven` is false when the request does not touch roles at all.
 */
function assertRoleChangeAllowed({ actor, target = null, selectedRoles = [], roleIdsGiven = true }) {
  if (!roleIdsGiven) return;
  if (!selectedRoles.length) {
    throw Object.assign(
      new Error('An account needs at least one role. To stop someone signing in, disable the account.'),
      { status: 400, code: 'ROLE_REQUIRED' },
    );
  }
  const grantsSuper = selectedRoles.some((r) => r.system_key === 'super_admin');
  const hadSuper = target ? hasRole(target, 'super_admin') : false;
  if (grantsSuper === hadSuper) return;
  const actorIsSuper = (actor?.role_keys || []).includes('super_admin');
  if (!actorIsSuper) {
    throw Object.assign(
      new Error('Only a super administrator can grant or remove the super administrator role.'),
      { status: 403, code: 'SUPER_ADMIN_ONLY' },
    );
  }
}

module.exports = {
  assertRoleChangeAllowed,
  resolveTargetOr404,
  activeSuperAdmins,
  assertSuperAdminFloor,
  hasRole,
};
