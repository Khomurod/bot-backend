'use strict';

/**
 * A small sliding-window limiter for the /qbq endpoints.
 *
 * Pairing is the endpoint that matters: a 6-character code is short enough to
 * read across a room, which also makes it short enough to grind at if nothing
 * stops the grinding. Per-code attempt burning (services/qbq/remoteSessions.js)
 * handles a targeted guess; this handles the broad sweep from one address.
 *
 * Buckets are pruned on read, so an idle limiter does not accumulate keys and
 * there is no timer to leak into the server process.
 */

class RateLimiter {
  /**
   * @param {object} options
   * @param {number} options.windowMs  sliding window width
   * @param {number} options.max       hits allowed per key per window
   * @param {number} [options.maxKeys] bound on tracked keys (memory guard)
   */
  constructor({ windowMs, max, maxKeys = 5000 }) {
    this.windowMs = windowMs;
    this.max = max;
    this.maxKeys = maxKeys;
    this.hits = new Map();
  }

  /**
   * Record one attempt.
   *
   * @returns {{limited: boolean, retryAfterSec: number}} `limited` true means
   *   the caller should answer 429 and NOT do the work.
   */
  check(key, now = Date.now()) {
    const cutoff = now - this.windowMs;
    const previous = this.hits.get(key) || [];
    const recent = previous.filter((t) => t > cutoff);

    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      const retryAfterSec = Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000));
      return { limited: true, retryAfterSec };
    }

    recent.push(now);
    this.hits.set(key, recent);

    // Opportunistic prune. Doing it here rather than on a timer keeps the
    // limiter inert when nothing is calling it.
    if (this.hits.size > this.maxKeys) {
      for (const [k, times] of this.hits) {
        if (!times.length || times[times.length - 1] <= cutoff) this.hits.delete(k);
        if (this.hits.size <= this.maxKeys) break;
      }
    }
    return { limited: false, retryAfterSec: 0 };
  }

  /** Test hook. */
  reset() {
    this.hits.clear();
  }
}

module.exports = { RateLimiter };
