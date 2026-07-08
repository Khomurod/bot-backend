/**
 * Admin authentication routes: POST /api/auth/login, GET /api/auth/verify.
 *
 * Routes use their full paths and the router is mounted at the app root, so
 * matching behavior is identical to the previous inline definitions.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

function createAuthRoutes({ db, config, authMiddleware }) {
  const router = express.Router();

  // ─── Login Rate Limiter (in-memory sliding window) ───
  // Simple per-IP throttle: 10 failed attempts in 15 minutes → 429.
  // Memory-only is acceptable for a single-dyno deployment; swap for a
  // shared store (Redis) before horizontal scaling.
  const LOGIN_WINDOW_MS = 15 * 60 * 1000;
  const LOGIN_MAX_FAILURES = 10;
  const loginAttempts = new Map(); // ip -> [timestamps]

  function loginRateLimit(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const attempts = (loginAttempts.get(ip) || []).filter((ts) => now - ts < LOGIN_WINDOW_MS);
    if (attempts.length >= LOGIN_MAX_FAILURES) {
      res.set('Retry-After', String(Math.ceil(LOGIN_WINDOW_MS / 1000)));
      return res.status(429).json({ error: 'Too many failed login attempts. Try again later.' });
    }
    loginAttempts.set(ip, attempts);
    req._loginIp = ip;
    next();
  }

  function recordLoginFailure(req) {
    const ip = req._loginIp;
    if (!ip) return;
    const attempts = loginAttempts.get(ip) || [];
    attempts.push(Date.now());
    loginAttempts.set(ip, attempts);
  }

  function clearLoginFailures(req) {
    if (req._loginIp) loginAttempts.delete(req._loginIp);
  }

  // POST /api/auth/login
  router.post('/api/auth/login', loginRateLimit, async (req, res) => {
    try {
      const { username, password } = req.body || {};
      if (typeof username !== 'string' || typeof password !== 'string'
          || !username.trim() || !password) {
        recordLoginFailure(req);
        return res.status(400).json({ error: 'Username and password required' });
      }

      const admin = await db.getAdminByUsername(username);
      if (!admin) {
        recordLoginFailure(req);
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const valid = await bcrypt.compare(password, admin.password_hash);
      if (!valid) {
        recordLoginFailure(req);
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = jwt.sign(
        { id: admin.id, username: admin.username },
        config.jwtSecret,
        { algorithm: 'HS256', expiresIn: '24h' }
      );

      clearLoginFailures(req);
      res.json({ token, username: admin.username });
    } catch (err) {
      console.error('[API] Login error:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // GET /api/auth/verify
  router.get('/api/auth/verify', authMiddleware, (req, res) => {
    res.json({ valid: true, username: req.admin.username });
  });

  return router;
}

module.exports = { createAuthRoutes };
