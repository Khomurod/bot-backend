/**
 * Working out what every active load is doing, on a timer.
 *
 * One pass, one fetch of each source. The load board and the fleet's positions
 * are each read ONCE and matched locally, so the cost of this job is the same
 * for ninety loads as for one — the shape the Live Locations map already uses.
 * It deliberately does not build the map's full snapshot, which geocodes and
 * computes ETAs that nothing here reads.
 *
 * The rules live in `lib/loads/lifecycle.js` and are pure. This module's whole
 * job is to supply them with a position, a load and what was witnessed before,
 * then write down the answer. That split is why every phase rule can be tested
 * without a database, a network, or a clock.
 *
 * What it does NOT do: change anything. A load's phase is a derived fact, and
 * an uncertain one becomes a Needs Attention finding for a person rather than a
 * correction. Nothing in this file writes to a driver's record.
 */
const { derivePhase, PHASES, PHASE_LABELS } = require('../../lib/loads/lifecycle');
const { extractUnitFromGroupName } = require('../../lib/drivers/driverGroupTitle');

const POLL_MS = 10 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 5 * 60 * 1000;

/** The unclear cases a person should see. High confidence files nothing. */
const CHECK_UNCLEAR = 'load.phase_unclear';

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    store: require('../../database/loadLifecycle'),
    groups: require('../../database/groups'),
    people: require('../../database/driverPeople'),
    findings: require('../../database/operationalFindings'),
    eldSettings: require('../../database/eldSettings'),
    providers: require('../liveLocations/providers'),
    orders: require('../liveLocations/orders'),
    loads: require('../datatruckLoadService'),
    notify: require('../notifications/send').notify,
  };
  /* eslint-enable global-require */
}

/** Find this group's truck in whichever provider has it. */
function positionFor(fleets, unit, driverName, deps) {
  if (!unit) return null;
  const resolved = deps.providers.resolveLocationForUnit(fleets, unit, driverName);
  const loc = resolved?.location;
  if (!loc || loc.lat == null || loc.lng == null) return null;
  return {
    lat: Number(loc.lat), lng: Number(loc.lng),
    speedMph: Number(loc.speedMph ?? 0),
    at: loc.lastUpdated || null,
  };
}

/**
 * A finding for a load whose phase cannot be settled.
 *
 * There is no `auto` tier here and no registered action, which is what makes
 * "Wenze never guesses a load's status" true by construction rather than by
 * care. The finding says what it saw and what disagreed; a person decides.
 */
function buildFinding(state, verdict) {
  const who = state.unitNumber ? `Unit ${state.unitNumber}` : `Load ${state.loadIdentifier || state.orderId}`;
  const why = verdict.conflicts.length
    ? 'the load board and the truck disagree'
    : 'there is not enough evidence to say';
  return {
    checkKey: CHECK_UNCLEAR,
    subjectType: 'load',
    // The order, not the driver: a driver runs many loads and each one is its
    // own question. Keyed on the driver, the second load would update the
    // first's finding instead of becoming a new one.
    subjectId: String(state.orderId),
    title: `${who}: ${why} — ${verdict.summary}`,
    severity: verdict.conflicts.length ? 'warning' : 'info',
    tier: 'warning',
    confidence: verdict.confidence === 'medium' ? 60 : 30,
    evidence: {
      phase: verdict.phase,
      boardStatus: verdict.facts.boardStatus,
      signals: verdict.signals,
      conflicts: verdict.conflicts,
      ...verdict.facts,
    },
    proposedChange: null,
  };
}

/** One load, one verdict, one row written. */
async function checkOneLoad(order, { fleets, groupsByUnit, nowIso, deps }) {
  const load = deps.loads.extractLoadFromOrder(order);
  if (!load || !load.orderId) return null;

  const unit = load.unitNumber || null;
  const group = unit ? groupsByUnit.get(String(unit)) : null;
  // The PERSON, not the chat. A driver who changes truck or group keeps their
  // identity, and this is the column every later feature joins on.
  const person = unit
    ? await deps.people.getOpenPersonForUnit(String(unit)).catch(() => null)
    : null;
  const position = positionFor(fleets, unit, group?.group_name || null, deps);
  const remembered = await deps.store.getLoadState(load.orderId);

  const verdict = derivePhase({
    nowIso,
    load,
    position,
    remembered: remembered
      ? { phase: remembered.phase, wasAtPickup: remembered.wasAtPickup, wasAtDelivery: remembered.wasAtDelivery }
      : {},
  });

  const state = await deps.store.recordLoadObservation(load.orderId, {
    loadIdentifier: load.loadIdentifier,
    groupId: group?.id || null,
    // `personId`, NOT `id`: getOpenPersonForUnit returns a driver_units ROW,
    // whose `id` is the assignment, not the human.
    personId: person?.personId ?? null,
    unitNumber: unit,
    phase: verdict.phase,
    confidence: verdict.confidence,
    atPickup: verdict.facts.atPickup === true,
    atDelivery: verdict.facts.atDelivery === true,
    lat: position?.lat ?? null,
    lng: position?.lng ?? null,
    speedMph: position?.speedMph ?? null,
    seenAt: position?.at ?? null,
    milesToPickup: verdict.facts.milesToPickup,
    milesToDelivery: verdict.facts.milesToDelivery,
    boardStatus: load.status || null,
    signals: verdict.signals,
    conflicts: verdict.conflicts,
    checkedAt: nowIso,
  });

  return { state, verdict, phaseChanged: remembered ? remembered.phase !== verdict.phase : true };
}

/**
 * One pass. Never throws.
 *
 * @returns {Promise<{checked:number, changed:number, unclear:number,
 *   conflicts:number, pruned:number, providerErrors:number, skipped?:string}>}
 */
async function runLoadLifecycleCheck({ now = Date.now(), deps = defaultDeps() } = {}) {
  const summary = {
    checked: 0, changed: 0, unclear: 0, conflicts: 0, pruned: 0, providerErrors: 0,
  };
  const nowIso = new Date(now).toISOString();
  try {
    // Both of these return an ENVELOPE, not the payload: fetchProviderFleets
    // gives { fleets, errors } and getActiveOrders gives { orders, error }.
    const cfg = await deps.eldSettings.getEldConfig();
    const [fleetResult, orderResult] = await Promise.all([
      deps.providers.fetchProviderFleets(cfg),
      deps.orders.getActiveOrders(now).catch(() => ({ orders: [], error: null })),
    ]);
    const fleets = fleetResult?.fleets || {};
    const orders = Array.isArray(orderResult?.orders) ? orderResult.orders : [];
    summary.providerErrors = (fleetResult?.errors?.length || 0) + (orderResult?.error ? 1 : 0);

    if (!orders.length) {
      summary.skipped = 'no_active_orders';
      summary.pruned = await deps.store.pruneFinishedLoads().catch(() => 0);
      return summary;
    }

    // Unit → group, so a load can name the driver carrying it. Built ONCE per
    // pass and matched locally: a per-load lookup would be one query per order.
    const groupsByUnit = new Map();
    const groups = await deps.groups.getDriverGroupsByActiveFilter('active').catch(() => []);
    for (const g of groups) {
      const unit = extractUnitFromGroupName(g.group_name);
      // First one wins. A unit on two active groups is a real condition in this
      // fleet — `identity.duplicate_unit` already files it for a person — and
      // picking the later row here would make a load's driver depend on the
      // order a SELECT happened to return.
      if (unit && !groupsByUnit.has(String(unit))) groupsByUnit.set(String(unit), g);
    }

    const keep = [];
    for (const order of orders) {
      // eslint-disable-next-line no-await-in-loop
      const out = await checkOneLoad(order, { fleets, groupsByUnit, nowIso, deps }).catch((err) => {
        console.warn('[LOADS] could not read one order:', err.message);
        return null;
      });
      if (!out) continue;
      summary.checked += 1;
      if (out.phaseChanged) summary.changed += 1;
      if (out.verdict.conflicts.length) summary.conflicts += 1;

      if (out.verdict.confidence === 'high') {
        keep.push(null); // nothing filed; the resolve below clears any old one
      } else {
        summary.unclear += 1;
        // eslint-disable-next-line no-await-in-loop
        const filed = await deps.findings.upsertFinding(buildFinding(out.state, out.verdict))
          .catch(() => null);
        if (filed?.id) keep.push(filed.id);
      }
    }

    // A load that became clear stops being a question.
    await deps.findings.resolveClearedFindings([CHECK_UNCLEAR], keep.filter(Boolean)).catch(() => {});
    summary.pruned = await deps.store.pruneFinishedLoads().catch(() => 0);

    if (summary.conflicts) {
      console.log(`[LOADS] ${summary.checked} loads checked, ${summary.changed} moved phase, `
        + `${summary.conflicts} where the board disagrees.`);
    }
    return summary;
  } catch (err) {
    console.error('[LOADS] lifecycle pass failed:', err.message);
    summary.error = err.message;
    return summary;
  }
}

let timer = null;
let stopped = false;
let tickRunning = false;

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    await runLoadLifecycleCheck({});
  } finally {
    tickRunning = false;
  }
}

function startLoadLifecycleWatch() {
  stopped = false;
  console.log(`[LOADS] Lifecycle watch started — every ${POLL_MS / 60000}min`);
  setTimeout(() => { if (!stopped) tick(); }, FIRST_TICK_DELAY_MS).unref?.();
  timer = setInterval(() => { if (!stopped) tick(); }, POLL_MS);
  timer.unref?.();
}

function stopLoadLifecycleWatch() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  POLL_MS,
  FIRST_TICK_DELAY_MS,
  CHECK_UNCLEAR,
  PHASES,
  PHASE_LABELS,
  buildFinding,
  checkOneLoad,
  runLoadLifecycleCheck,
  startLoadLifecycleWatch,
  stopLoadLifecycleWatch,
};
