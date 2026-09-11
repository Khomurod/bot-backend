/**
 * Whether a driver has a PATTERN, or just had a bad moment. PURE.
 *
 * Every safety alert today is treated as an isolated incident, which is the
 * framing that makes coaching impossible: a first hard brake in traffic and the
 * fourth this week produce the same message. A driver who gets the same note
 * every time stops reading it, and the one time it mattered is lost in the
 * noise.
 *
 * So nothing here fires on a single event. A pattern needs REPETITION, over a
 * window, above what the rest of the fleet is doing — and the numbers that
 * justified it travel with the verdict so a safety manager can disagree with it
 * rather than having to trust it.
 *
 * WHAT THIS DELIBERATELY DOES NOT PRODUCE: a score, a ranking, or a
 * recommendation about a person's employment. It says "this happened this many
 * times" and "here is a sentence a driver can act on". Deciding what that MEANS
 * about a driver is a human judgement, and the schema and the prompt both keep
 * it that way.
 */

/** Samsara's labels arrive in several spellings; these are the ones we coach. */
const BEHAVIORS = Object.freeze({
  HARSH_BRAKING: 'harsh_braking',
  HARSH_ACCELERATION: 'harsh_acceleration',
  HARSH_TURN: 'harsh_turn',
  SPEEDING: 'speeding',
  FOLLOWING_DISTANCE: 'following_distance',
  MOBILE_USAGE: 'mobile_usage',
  SEATBELT: 'seatbelt',
});

/** What a driver can actually DO about each, in one clause. */
const COACHING_POINT = Object.freeze({
  [BEHAVIORS.HARSH_BRAKING]: 'leaving more room ahead so stops can be gentler',
  [BEHAVIORS.HARSH_ACCELERATION]: 'easing onto the throttle, especially loaded',
  [BEHAVIORS.HARSH_TURN]: 'taking ramps and corners a little slower',
  [BEHAVIORS.SPEEDING]: 'keeping to the posted limit',
  [BEHAVIORS.FOLLOWING_DISTANCE]: 'holding a bigger gap to the vehicle ahead',
  [BEHAVIORS.MOBILE_USAGE]: 'leaving the phone alone while the truck is moving',
  [BEHAVIORS.SEATBELT]: 'belting up before moving off',
});

const DEFAULTS = Object.freeze({
  /** How far back a pattern is looked for. */
  windowDays: 14,
  /** Fewest events of one kind before it is a pattern at all. */
  minEvents: 3,
  /** At or above this, it is worth a person's attention as well. */
  escalateEvents: 6,
  /** Do not coach the same behaviour again inside this many days. */
  coachingQuietDays: 14,
  /** A driver with fewer events than this in total is not coached about anything. */
  minTotalEvents: 3,
});

/**
 * Normalise Samsara's many spellings into one key.
 *
 * `HarshBraking`, `harsh_braking`, `Harsh Braking` and `HARSH BRAKING` are the
 * same behaviour, and a pattern counted across four spellings is four patterns
 * of one event each — which never reaches a threshold, so the feature would
 * silently never fire.
 */
function normaliseBehavior(raw) {
  const s = String(raw || '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase()
    .replace(/[^a-z_]/g, '');
  if (!s) return null;
  if (/brak/.test(s)) return BEHAVIORS.HARSH_BRAKING;
  if (/accel/.test(s)) return BEHAVIORS.HARSH_ACCELERATION;
  if (/turn|corner/.test(s)) return BEHAVIORS.HARSH_TURN;
  if (/speed/.test(s)) return BEHAVIORS.SPEEDING;
  if (/follow|tailgat/.test(s)) return BEHAVIORS.FOLLOWING_DISTANCE;
  if (/mobile|phone|distract/.test(s)) return BEHAVIORS.MOBILE_USAGE;
  if (/seatbelt|belt/.test(s)) return BEHAVIORS.SEATBELT;
  return null;
}

/** A crash is never a coaching moment. It is an incident, and a person owns it. */
function isCollision(raw) {
  return /crash|collision|rollover/i.test(String(raw || ''));
}

function daysBetween(aIso, bMs) {
  const t = Date.parse(aIso);
  return Number.isFinite(t) ? (bMs - t) / 86400000 : null;
}

/**
 * Find the patterns in one driver's recent events.
 *
 * @param {object} input
 * @param {string} input.nowIso
 * @param {object[]} input.events   `{behavior, occurredAt, severity, gForce, speedMph}`
 * @param {object[]} [input.coaching]  what has already been said: `{behavior, sentAt}`
 * @param {object} [input.options]
 * @returns {{patterns:object[], totals:object, coachable:object[], escalate:object[]}}
 */
function findPatterns({ nowIso, events = [], coaching = [], options = {} } = {}) {
  const opts = { ...DEFAULTS, ...options };
  const nowMs = Date.parse(nowIso) || Date.now();

  const inWindow = events.filter((e) => {
    const age = daysBetween(e.occurredAt, nowMs);
    return age != null && age >= 0 && age <= opts.windowDays;
  });

  const byBehavior = new Map();
  for (const e of inWindow) {
    const key = normaliseBehavior(e.behavior);
    if (!key) continue;
    if (!byBehavior.has(key)) byBehavior.set(key, []);
    byBehavior.get(key).push(e);
  }

  const totals = { inWindow: inWindow.length, byBehavior: {} };
  for (const [key, list] of byBehavior) totals.byBehavior[key] = list.length;

  const lastCoached = new Map();
  for (const c of coaching) {
    const key = normaliseBehavior(c.behavior) || c.behavior;
    const age = daysBetween(c.sentAt, nowMs);
    if (age == null) continue;
    if (!lastCoached.has(key) || age < lastCoached.get(key)) lastCoached.set(key, age);
  }

  const patterns = [];
  for (const [behavior, list] of byBehavior) {
    if (list.length < opts.minEvents) continue;
    const sorted = [...list].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    const spanDays = Math.max(1, Math.round(
      (Date.parse(sorted[sorted.length - 1].occurredAt) - Date.parse(sorted[0].occurredAt)) / 86400000
    ));
    const worstG = list.reduce((m, e) => Math.max(m, Number(e.gForce) || 0), 0) || null;
    const daysSinceCoached = lastCoached.has(behavior) ? lastCoached.get(behavior) : null;

    patterns.push({
      behavior,
      count: list.length,
      spanDays,
      windowDays: opts.windowDays,
      worstGForce: worstG,
      lastAt: sorted[sorted.length - 1].occurredAt,
      coachingPoint: COACHING_POINT[behavior] || null,
      // Said recently enough that saying it again is nagging.
      recentlyCoached: daysSinceCoached != null && daysSinceCoached < opts.coachingQuietDays,
      daysSinceCoached: daysSinceCoached == null ? null : Math.round(daysSinceCoached),
      escalate: list.length >= opts.escalateEvents,
    });
  }

  patterns.sort((a, b) => b.count - a.count);

  // A driver with almost no events is not coached about anything, even if one
  // behaviour happens to clear its own threshold: the point is a habit, and
  // three events in a fortnight across a whole fleet is ordinary driving.
  const enoughToSpeak = totals.inWindow >= opts.minTotalEvents;

  return {
    patterns,
    totals,
    coachable: enoughToSpeak ? patterns.filter((p) => !p.recentlyCoached) : [],
    escalate: patterns.filter((p) => p.escalate),
  };
}

module.exports = {
  BEHAVIORS, COACHING_POINT, DEFAULTS,
  normaliseBehavior, isCollision, findPatterns,
};
