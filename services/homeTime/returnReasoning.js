/**
 * Asking a model to read the evidence — never to supply it.
 *
 * This is consulted for exactly one situation: the deterministic rules came
 * back MEDIUM. High needs no help and low has nothing to interpret, so a
 * confident case never costs an AI call and neither does a quiet fleet.
 *
 * What the model may do, and what it may not:
 *
 *   MAY  agree that facts already recorded add up to a return — but only when
 *        the deterministic hard gate (a load AND proven movement, fresh GPS,
 *        not parked at home) is ALREADY satisfied. `movementProven` is computed
 *        from coordinates and timestamps, not from anything the model says.
 *   MAY  disagree, which drops the case to low and changes nothing.
 *   MAY NOT introduce a fact. It is sent the facts as numbers and booleans and
 *        is asked for a verdict, not for a story.
 *
 * So the worst a wrong model can do here is leave a real return for a person to
 * notice, or add a Needs Attention item. It cannot move a driver on its own.
 */
const { CONFIDENCE } = require('../../lib/homeTime/returnEvidence');

const CAPABILITY = 'home_time_return_to_road';

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    runCapability: require('../ai/router').runCapability,
    isCapabilityEnabled: require('../ai/capabilityGate').isCapabilityEnabled,
  };
  /* eslint-enable global-require */
}

/**
 * The prompt. PURE, and deliberately free of names, chats and coordinates: the
 * model sees a shape, not a person.
 */
function buildPrompt({ verdict, load, homeHours }) {
  const f = verdict.facts;
  return [
    'A US trucking company tracks whether a driver who went home has returned to work.',
    'Decide ONLY from the recorded facts below. Do not assume anything that is not listed.',
    '',
    'Facts:',
    `- hours since the driver was marked home: ${homeHours == null ? 'unknown' : homeHours}`,
    `- has an active load: ${f.hasLoad}`,
    `- load status: ${f.loadStatus || 'none'}`,
    `- GPS is fresh: ${f.gpsFresh} (age ${f.gpsAgeMinutes == null ? 'unknown' : `${f.gpsAgeMinutes} min`})`,
    `- truck moving right now: ${f.movingNow}`,
    `- separate sightings of movement: ${f.movingSightings}`,
    `- furthest the truck has been from its home parking spot: ${f.milesFromHome == null ? 'unknown' : `${f.milesFromHome} mi`}`,
    `- distance from that spot right now: ${f.milesFromHomeNow == null ? 'unknown' : `${f.milesFromHomeNow} mi`}`,
    `- distance to the load pickup: ${f.milesToPickup == null ? 'unknown' : `${f.milesToPickup} mi`}`,
    `- deterministic signals: ${verdict.signals.join(', ') || 'none'}`,
    `- deterministic doubts: ${verdict.blockers.join(', ') || 'none'}`,
    `- pickup appointment: ${load?.pickupTime || 'unknown'}`,
    '',
    'A load assigned to a driver who is still at home is normal planning, NOT a return to work.',
    'Only movement of the truck, consistent with the load, shows work has started.',
    '',
    'Respond with JSON only:',
    '{"returned":true|false,"confidence":0-100,"reason":"<one short sentence>"}',
  ].join('\n');
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * @returns {Promise<object|null>} an adjusted verdict, or null to keep the
 *   deterministic one unchanged (the answer whenever anything goes wrong).
 */
async function reviewReturnEvidence({ verdict, load = null, homeHours = null } = {}, deps = defaultDeps()) {
  try {
    if (!verdict || verdict.confidence !== CONFIDENCE.MEDIUM) return null;
    if (!(await deps.isCapabilityEnabled(CAPABILITY))) return null;

    const { parsed, provider, model } = await deps.runCapability({
      capability: CAPABILITY,
      userText: buildPrompt({ verdict, load, homeHours }),
      expects: 'json',
      validate: (p) => (typeof p?.returned === 'boolean'
        ? true
        : { message: 'expected {"returned": boolean}' }),
    });

    const confidence = clampConfidence(parsed.confidence);
    const reason = String(parsed.reason || '').slice(0, 200);

    // THE GATE. An upgrade is only ever possible when the coordinates already
    // said so. The model is agreeing with arithmetic, not replacing it.
    if (parsed.returned === true && verdict.facts.movementProven && !verdict.facts.parkedAtHome
      && verdict.facts.hasLoad && (confidence == null || confidence >= 80)) {
      return {
        ...verdict,
        confidence: CONFIDENCE.HIGH,
        aiAssisted: true,
        aiProvider: provider || null,
        aiModel: model || null,
        aiConfidence: confidence,
        aiReason: reason,
        signals: [...verdict.signals, 'ai_agreed'],
        summary: `${verdict.summary} + reviewed`,
      };
    }

    // A "no" is always allowed to stand a case down — being wrong that way
    // costs a Needs Attention item, not a driver's record.
    if (parsed.returned === false) {
      return {
        ...verdict,
        confidence: CONFIDENCE.LOW,
        aiAssisted: true,
        aiProvider: provider || null,
        aiModel: model || null,
        aiConfidence: confidence,
        aiReason: reason,
        blockers: [...verdict.blockers, 'ai_disagreed'],
      };
    }
    return null;
  } catch (err) {
    // No model, no opinion, no change. The deterministic verdict already stands.
    return null;
  }
}

module.exports = { CAPABILITY, buildPrompt, reviewReturnEvidence };
