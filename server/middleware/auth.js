/**
 * Shared HTTP auth middleware factories.
 *
 * Factories (rather than singletons) so each api.js load builds middleware
 * bound to ITS config instance — the test suite re-requires server/api.js with
 * a swapped config module, and closing over a stale config would break that.
 */
const jwt = require('jsonwebtoken');

/** Admin JWT guard used by every /api/* admin endpoint. */
function createAuthMiddleware(config) {
  return function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    try {
      // Pin the algorithm to HS256 so a token forged with alg:"none" or an
      // asymmetric alg cannot impersonate an admin.
      const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
      req.admin = decoded;
      next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid token' });
    }
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
function createProxyAuthGuard(config) {
  return function proxyAuthGuard(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
      jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  };
}

module.exports = {
  createAuthMiddleware,
  createInternalSharedSecretGuard,
  createProxyAuthGuard,
};
