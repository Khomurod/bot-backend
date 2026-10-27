'use strict';

/**
 * A small in-memory sliding-window limiter for routes that call outside
 * services on a person's click (Settings → Facebook ↔ Bitrix → Test asks Meta
 * and Bitrix). Keyed by the signed-in admin, falling back to the IP.
 *
 * Memory-only, like the login limiter in server/routes/authRoutes.js: this
 * deployment is one process. A restart forgets the window, which costs at most
 * one extra burst.
 */
function createRateLimiter({ windowMs, max, message, keyOf = null, now = () => Date.now() }) {
  const hits = new Map(); // key -> [timestamps]
  return function rateLimit(req, res, next) {
    const key = keyOf ? keyOf(req) : (req.admin?.id ? `admin:${req.admin.id}` : `ip:${req.ip || 'unknown'}`);
    const t = now();
    const recent = (hits.get(key) || []).filter((ts) => t - ts < windowMs);
    if (recent.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((windowMs - (t - recent[0])) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message || `Too many requests. Try again in ${retryAfter} seconds.`, retryAfterSeconds: retryAfter });
    }
    recent.push(t);
    hits.set(key, recent);
    // Forget keys nobody has used for a while, so the map cannot grow forever.
    if (hits.size > 500) {
      for (const [k, list] of hits) if (!list.some((ts) => t - ts < windowMs)) hits.delete(k);
    }
    return next();
  };
}

module.exports = { createRateLimiter };
