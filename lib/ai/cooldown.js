/**
 * How long a provider stays out of rotation, and why. PURE — a timestamp
 * comparison and some arithmetic, no I/O and no state.
 *
 * This is the whole circuit breaker. It is deliberately not a library: the
 * decision is "is `cooled_until` in the past?", and the interesting part is not
 * the mechanism but the DURATION, which differs by failure class in ways a
 * generic breaker cannot know.
 *
 *   TRANSIENT → seconds, doubling. The provider is busy, not broken. Modelled
 *   on ai-fallback's `modelResetInterval` (3 minutes by default, then return to
 *   the PREFERRED provider) so free-tier priority self-restores rather than
 *   drifting permanently onto whichever provider happened to answer last.
 *
 *   QUOTA → until the limit actually resets. If the provider stated a time, use
 *   it. Otherwise assume a daily allowance and wait for the next UTC midnight —
 *   the convention every free tier here documents. Guessing shorter means
 *   hammering a provider that has already said no; guessing longer means
 *   throwing away hours of a free allowance nobody paid for.
 *
 *   CREDENTIAL → INDEFINITE. Not a long timer: a sentinel, because no elapsed
 *   time makes an expired key work. It clears when an administrator edits the
 *   provider, which is the only event that can actually fix it.
 *
 * A cooldown is never silent. Every one carries a reason, and that reason is
 * what the admin panel shows and what a `serious` finding quotes — "AI is
 * degraded" is not a useful thing to learn from a latency graph.
 *
 * NOTHING HERE EVER DISABLES A PROVIDER PERMANENTLY. Cooling is reversible by
 * definition, an admin can clear one in a click, and no code path writes
 * `enabled = false`. That separation matters: `enabled` is a human's decision,
 * `cooled_until` is the system's temporary opinion, and conflating them would
 * let a bad afternoon look like a configuration change.
 */
const { FAILURE } = require('./classify');

/** Transient backoff ladder, in ms. Doubles, then holds. */
const TRANSIENT_LADDER_MS = [30_000, 60_000, 180_000, 300_000];
/** The sentinel for "a person has to fix this". */
const INDEFINITE = 'indefinite';
/** Never cool a provider for longer than this on a guess. */
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** Next UTC midnight — the reset every free tier in use here documents. */
function nextUtcMidnight(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

/**
 * Decide the cooldown for one failure.
 *
 * @param {object} args
 * @param {string} args.kind            a FAILURE.* from ./classify
 * @param {number} [args.consecutiveFailures=1]  how many in a row for this provider
 * @param {number} [args.retryAfterMs=0] what the provider itself asked for
 * @param {number} [args.now=Date.now()]
 * @returns {{until: number|'indefinite'|null, reason: string|null}}
 *   `until` null = do not cool at all.
 */
function cooldownFor({
  kind, consecutiveFailures = 1, retryAfterMs = 0, now = Date.now(),
} = {}) {
  if (kind === FAILURE.CREDENTIAL) {
    return {
      until: INDEFINITE,
      reason: 'The credential was rejected. No amount of waiting fixes this — '
        + 'an administrator has to replace the key, and saving it clears this automatically.',
    };
  }

  if (kind === FAILURE.QUOTA) {
    // A provider that named its own reset is believed, up to a day.
    if (retryAfterMs > 0) {
      return {
        until: now + Math.min(retryAfterMs, MAX_COOLDOWN_MS),
        reason: `The allowance is spent; the provider asked to be left alone for `
          + `${Math.round(retryAfterMs / 1000)}s.`,
      };
    }
    return {
      until: nextUtcMidnight(now),
      reason: 'The allowance is spent and no reset time was given, so this waits for the '
        + 'next UTC day — the reset every free tier here documents.',
    };
  }

  if (kind === FAILURE.TRANSIENT) {
    const index = Math.min(Math.max(consecutiveFailures, 1) - 1, TRANSIENT_LADDER_MS.length - 1);
    const wait = Math.max(TRANSIENT_LADDER_MS[index], retryAfterMs);
    return {
      until: now + Math.min(wait, MAX_COOLDOWN_MS),
      reason: `Temporarily unavailable (${consecutiveFailures} in a row); `
        + `retrying in ${Math.round(wait / 1000)}s.`,
    };
  }

  // FATAL_REQUEST, INVALID_RESPONSE, UNKNOWN — our problem or nobody's.
  return { until: null, reason: null };
}

/**
 * Is this provider available right now?
 *
 * The three states are deliberately distinguishable, because they need
 * different words in the admin: a person turned it off, the system is waiting,
 * or it is ready.
 */
function isAvailable(provider, now = Date.now()) {
  if (!provider || provider.enabled !== true) return false;
  const until = provider.cooledUntil;
  if (until == null) return true;
  if (until === INDEFINITE) return false;
  const at = until instanceof Date ? until.getTime() : new Date(until).getTime();
  if (Number.isNaN(at)) return true; // an unreadable value must not strand a provider
  return at <= now;
}

/** Why a provider is not being used, in words. */
function unavailableReason(provider, now = Date.now()) {
  if (!provider) return 'No such provider.';
  if (provider.enabled !== true) return 'Turned off by an administrator.';
  if (isAvailable(provider, now)) return null;
  if (provider.cooledUntil === INDEFINITE) {
    return provider.cooldownReason || 'Waiting for an administrator.';
  }
  const at = new Date(provider.cooledUntil).getTime();
  const seconds = Math.max(0, Math.round((at - now) / 1000));
  return `${provider.cooldownReason || 'Cooling down'} (${seconds}s remaining).`;
}

/**
 * The providers to try, in order.
 *
 * `priority` ascending, so 1 is tried first. `roundRobin` rotates the starting
 * point across the SAME ordered list rather than shuffling it — the goal is to
 * spread load over several equivalent free tiers so no single allowance is
 * always the one burned first, not to randomise.
 *
 * `freeOnly` is a hard filter, not a preference: it exists so an operator can
 * guarantee no paid call is ever made, and a preference would not guarantee it.
 */
function eligibleProviders(providers, {
  now = Date.now(), freeOnly = false, roundRobin = false, rotation = 0,
} = {}) {
  const ordered = (providers || [])
    .filter((p) => isAvailable(p, now))
    .filter((p) => !freeOnly || p.isFree === true)
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999)
      || String(a.providerKey).localeCompare(String(b.providerKey)));

  if (!roundRobin || ordered.length < 2) return ordered;
  const offset = ((rotation % ordered.length) + ordered.length) % ordered.length;
  return [...ordered.slice(offset), ...ordered.slice(0, offset)];
}

module.exports = {
  INDEFINITE,
  TRANSIENT_LADDER_MS,
  MAX_COOLDOWN_MS,
  nextUtcMidnight,
  cooldownFor,
  isAvailable,
  unavailableReason,
  eligibleProviders,
};
