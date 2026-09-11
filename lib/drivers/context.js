'use strict';

/**
 * Everything Wenze knows about one driver, in one shape — and where those
 * things disagree.
 *
 * WHY THIS EXISTS. Each feature reads its own table and reaches its own verdict
 * about the same human. Home Time says they are at home; the load board says
 * their truck is in transit; retention says they have gone quiet while safety
 * recorded three hard stops this morning. Nothing anywhere put those side by
 * side, so each feature was confidently right in its own terms and the
 * contradiction lived only in the head of whoever happened to read two screens.
 *
 * THE RULE THIS MODULE WILL NOT BREAK: a contradiction is REPORTED, never
 * resolved. When two features disagree about a driver, the answer is not the
 * more recent one, the more confident one, or the one with more rows. It is
 * that a person must look. Picking a side here would be the same mistake as
 * picking a side between two sources — one module down, and with worse
 * consequences, because this one is about a named human.
 *
 * AND "QUIET" IS NOT "GONE". The most valuable contradiction here is the
 * cross-feature form of stale-is-not-inactive: one feature calls a driver
 * inactive because ITS source stopped reporting, while another shows them
 * plainly working. A retention notice about a driver who drove 400 miles
 * yesterday is not a retention signal, it is a broken feed — and telling those
 * apart is the whole point of holding the picture in one place.
 */

/** A fact nobody could establish. Distinct from a fact established as absent. */
const UNKNOWN = null;

/**
 * @param {object} parts
 * @returns {object} the normalised context — every section present, with
 *   `known: false` where nothing could be read
 */
function describeContext(parts = {}) {
  return {
    personId: parts.personId ?? UNKNOWN,
    identity: section(parts.identity),
    homeTime: section(parts.homeTime),
    loads: section(parts.loads),
    fuel: section(parts.fuel),
    safety: section(parts.safety),
    retention: section(parts.retention),
  };
}

/**
 * A section that could not be read is `known: false` — NOT an empty one.
 *
 * The distinction is the whole reason this file exists: "this driver has no
 * safety events" and "we could not read the safety table" produce identical
 * empty objects, and only one of them is a reason to relax.
 */
function section(value) {
  if (value == null) return { known: false };
  return { known: true, ...value };
}

/** Minutes between an ISO timestamp and now, or null when unreadable. */
function minutesSince(iso, nowMs) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (nowMs - t) / 60000);
}

/**
 * Where the picture disagrees with itself.
 *
 * Each contradiction names BOTH sides and what each was reading, because the
 * useful sentence for a person is never "something is wrong with driver 12" —
 * it is "Home Time thinks they are home since Tuesday and the load board has
 * them delivering in Ohio this morning".
 *
 * @returns {Array<{kind:string, summary:string, sides:string[], evidence:object}>}
 */
function findContradictions(context, { now = null, activeWithinMinutes = 720 } = {}) {
  const nowMs = now ? Date.parse(now) : Date.now();
  const out = [];
  const { homeTime, loads, fuel, safety, retention } = context || {};

  // ── at home, and simultaneously working ──────────────────────────────────
  if (homeTime?.known && homeTime.state === 'home' && loads?.known && loads.movingPhase) {
    out.push({
      kind: 'home_while_working',
      summary: `Home Time has them at home since ${homeTime.stateSince || 'an unrecorded date'}, `
        + `and the load board has them ${loads.movingPhase}`,
      sides: ['home_time', 'loads'],
      evidence: { stateSince: homeTime.stateSince, phase: loads.movingPhase, orderId: loads.orderId },
    });
  }

  // ── the one that matters most: quiet in one place, busy in another ───────
  const activity = [];
  const fuelAge = minutesSince(fuel?.newestReadingAt, nowMs);
  if (fuel?.known && fuelAge != null && fuelAge <= activeWithinMinutes) {
    activity.push(`a fuel reading ${Math.round(fuelAge / 60)}h ago`);
  }
  const safetyAge = minutesSince(safety?.newestEventAt, nowMs);
  if (safety?.known && safetyAge != null && safetyAge <= activeWithinMinutes) {
    activity.push(`a safety event ${Math.round(safetyAge / 60)}h ago`);
  }
  if (loads?.known && loads.movingPhase) activity.push(`a load ${loads.movingPhase}`);

  if (retention?.known && retention.goneQuiet && activity.length) {
    out.push({
      kind: 'quiet_but_active',
      // NOT a retention signal. A driver who was driving this morning has not
      // gone quiet; a feed has.
      summary: 'Retention has them as gone quiet, but the fleet shows '
        + `${activity.join(' and ')} — this is more likely a source that stopped `
        + 'reporting than a driver who stopped working',
      sides: ['retention', ...(fuelAge != null ? ['fuel'] : []), ...(safetyAge != null ? ['safety'] : [])],
      evidence: { activity, goneQuietSince: retention.goneQuietSince || null },
    });
  }

  // ── two trucks at once ───────────────────────────────────────────────────
  if (identityDisagrees(context)) {
    out.push({
      kind: 'two_open_units',
      summary: `Identity has ${context.identity.openUnits.length} trucks open for this `
        + 'person at the same time',
      sides: ['identity'],
      evidence: { units: context.identity.openUnits },
    });
  }

  return out;
}

function identityDisagrees(context) {
  const units = context?.identity?.known ? context.identity.openUnits : null;
  return Array.isArray(units) && units.length > 1;
}

/**
 * How much of the picture we actually have.
 *
 * Reported so a caller can tell a confident reading from a lucky one: three
 * sections unreadable and no contradictions found is not a clean bill of
 * health, it is a mostly-blank page.
 */
function coverage(context) {
  const sections = ['identity', 'homeTime', 'loads', 'fuel', 'safety', 'retention'];
  const known = sections.filter((k) => context?.[k]?.known === true);
  return { known: known.length, total: sections.length, missing: sections.filter((k) => !context?.[k]?.known) };
}

module.exports = { UNKNOWN, describeContext, findContradictions, coverage };
