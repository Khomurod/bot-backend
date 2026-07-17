/**
 * User-administration scoping — pure authorization helpers.
 *
 * Two tiers of user administrator:
 *   - Full admin (`users.manage`): may see and manage every account.
 *   - Trailer Manager (`trailer_users.manage` but NOT `users.manage`): may see
 *     and manage ONLY accounts whose roles are all Trailer Department roles.
 *     Super administrators and unrelated admins must be invisible — not merely
 *     un-editable — so a Trailer Manager cannot even infer they exist. Requests
 *     targeting an out-of-scope account return 404, never 403.
 *
 * Keeping these decisions pure makes the authorization matrix unit-testable.
 */
'use strict';

function permissionSet(req) {
  return new Set(req.admin?.permissions || []);
}

/** Full administrators may manage everyone. */
function isFullUserAdmin(req) {
  return permissionSet(req).has('users.manage');
}

/** A Trailer Manager is trailer-scoped: trailer_users.manage without users.manage. */
function isTrailerScopedAdmin(req) {
  const perms = permissionSet(req);
  return perms.has('trailer_users.manage') && !perms.has('users.manage');
}

/** A user is in the trailer scope when it has at least one role and every role is trailer_. */
function isTrailerOnlyUser(user) {
  const roles = user?.roles || [];
  if (!roles.length) return false;
  return roles.every((r) => String(r.system_key || '').startsWith('trailer_'));
}

function hasRole(user, systemKey) {
  return (user?.roles || []).some((r) => r.system_key === systemKey);
}

/** Filter the full user list down to what the caller may see. */
function visibleUsers(req, users) {
  if (isFullUserAdmin(req)) return users;
  return users.filter(isTrailerOnlyUser);
}

/**
 * Resolve a target user the caller is allowed to act on, or throw 404 so an
 * out-of-scope account is indistinguishable from one that does not exist.
 */
function resolveTargetOr404(req, users, id) {
  const target = users.find((u) => Number(u.id) === Number(id));
  if (!target) throw Object.assign(new Error('User not found.'), { status: 404 });
  if (!isFullUserAdmin(req) && !isTrailerOnlyUser(target)) {
    throw Object.assign(new Error('User not found.'), { status: 404 });
  }
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
  isFullUserAdmin,
  isTrailerScopedAdmin,
  isTrailerOnlyUser,
  visibleUsers,
  resolveTargetOr404,
  activeSuperAdmins,
  assertSuperAdminFloor,
  hasRole,
};
