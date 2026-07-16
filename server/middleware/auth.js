/**
 * Shared HTTP auth middleware factories.
 *
 * Factories (rather than singletons) so each api.js load builds middleware
 * bound to ITS config instance — the test suite re-requires server/api.js with
 * a swapped config module, and closing over a stale config would break that.
 */
const jwt = require('jsonwebtoken');

/** Admin JWT guard used by every /api/* admin endpoint. */
function createAuthMiddleware(config, dbOverride = null) {
  const db = dbOverride || require('../../database/db');
  return async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    try {
      // Pin the algorithm to HS256 so a token forged with alg:"none" or an
      // asymmetric alg cannot impersonate an admin.
      const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
      let admin;
      if (typeof db.getAdminAuthorization === 'function') admin = await db.getAdminAuthorization(decoded.id);
      else if (typeof db.getAdminByUsername === 'function') {
        const legacy = await db.getAdminByUsername(decoded.username);
        if (legacy) admin = { id: legacy.id, username: legacy.username, active: legacy.active !== false,
          auth_version: legacy.auth_version || 1, role_keys: ['super_admin'], permissions: ['admin.full_access'] };
      } else admin = { id: decoded.id, username: decoded.username, active: true,
        auth_version: decoded.auth_version || 1, role_keys: ['super_admin'], permissions: ['admin.full_access'] };
      if (!admin || !admin.active) return res.status(401).json({ error: 'Account is disabled or no longer exists' });
      if (decoded.auth_version != null && Number(decoded.auth_version) !== Number(admin.auth_version)) {
        return res.status(401).json({ error: 'Session is no longer valid' });
      }
      req.admin = admin;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

function requirePermission(...needed) {
  return function permissionMiddleware(req, res, next) {
    const have = new Set(req.admin?.permissions || []);
    if (!needed.some((permission) => have.has(permission))) {
      return res.status(403).json({ error: `Missing permission: ${needed.join(' or ')}` });
    }
    return next();
  };
}

function requireAllPermissions(...needed) {
  return function permissionMiddleware(req, res, next) {
    const have = new Set(req.admin?.permissions || []);
    if (!needed.every((permission) => have.has(permission))) {
      return res.status(403).json({ error: `Missing required permissions: ${needed.join(', ')}` });
    }
    return next();
  };
}

/** Shared-secret guard for server-to-server calls from the leads engine. */
function createInternalSharedSecretGuard(config) {
  return function internalSharedSecretGuard(req, res, next) {
    const provided = String(req.headers['x-internal-shared-secret'] || '');
    if (!provided || provided !== config.leadsInternalSharedSecret) {
      return res.status(401).json({ error: 'Unauthorized internal request' });
    }
    return next();
  };
}

/**
 * Minimal JWT check for routes registered BEFORE express.json() (leads-bot
 * proxy log/retry) — cannot use authMiddleware there because it is defined
 * after the body parsers in the mount order.
 */
function createProxyAuthGuard(config, dbOverride = null) {
  const auth = createAuthMiddleware(config, dbOverride);
  const fullAccess = requirePermission('admin.full_access');
  return function proxyAuthGuard(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    return auth(req, res, (error) => error ? next(error) : fullAccess(req, res, next));
  };
}

module.exports = {
  createAuthMiddleware,
  createInternalSharedSecretGuard,
  createProxyAuthGuard,
  requirePermission,
  requireAllPermissions,
};
