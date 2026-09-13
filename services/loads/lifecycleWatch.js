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
const { withRunRecord } = require('../operations/runLedger');

const POLL_MS = 10 * 60 * 1000;
/**
 * How long one load stays quiet after being reported.
 *
 * A day: a contradiction that is still there tomorrow is worth saying again,
 * and the same one every ten minutes is how a channel becomes unread.
 */
const REPEAT_AFTER_HOURS = 24;
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
    notifications: require('../../database/operationalNotifications'),
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

/** How long a load may sit unreadable before it is a question rather than a Tuesday. */
const STUCK_HOURS = 12;

/**
 * Is this load a QUESTION, or just an ordinary load?
 *
 * The first version filed a finding for every load that was not high
 * confidence, and production showed immediately why that is wrong: 191 of 235
 * loads, which buried the fifteen findings that actually needed somebody.
 *
 * The reason is in this module's own design. `heading_to_pickup` is ALWAYS
 * medium confidence — deliberately, because it is an inference from a truck
 * moving the right way and never an observation — so every load in that phase
 * filed a permanent "there is not enough evidence to say", for the whole trip.
 * That is not a question anybody can answer. It is what the phase means.
 *
 * A load is worth asking about when:
 *
 *   THE SOURCES DISAGREE. The board says delivered and the truck is at the
 *   pickup. Somebody has to reconcile that, and it is exactly the case the
 *   owner asked to be surfaced instead of guessed.
 *
 *   OR IT HAS BEEN UNREADABLE FOR HALF A DAY. A load assigned twenty minutes
 *   ago whose truck has not set off is not a problem; the same load twelve
 *   hours later is either not moving or not being reported, and both are worth
 *   a look.
 *
 * Everything else is ordinary uncertainty about a load that is fine.
 */
function worthAsking(out, nowIso) {
  if (out.verdict.confidence === 'high') return false;
  if (out.verdict.conflicts.length > 0) return true;

  // Unchanged phase plus a stale start is what "stuck" means. A phase that just
  // moved is not stuck however little is known about it.
  if (out.phaseChanged) return false;
  // The REMEMBERED phase start, not the row just written. "How long has this
  // been stuck" is a question about what was already there; reading it off the
  // write couples the answer to whatever the store happens to return.
  const since = Date.parse(out.remembered?.phaseSince || '');
  if (!Number.isFinite(since)) return false;
  return (Date.parse(nowIso) - since) >= STUCK_HOURS * 3600 * 1000;
}

/**
 * The one person recorded in a unit number, or nobody — and WHICH KIND of
 * nobody.
 *
 * `person` is a `driver_units` row (whose `personId` is the human) only when
 * the number is unambiguous. Two holders means two fleets, or a handover
 * nobody closed; either way it is not this watch's to resolve.
 *
 * `known` is the half that matters for a load already carrying a person.
 * "I read the holders and there is no single one" and "I could not read them"
 * are different answers: the first is grounds to REMOVE a person already
 * stamped on the load, the second is grounds to touch nothing. A read that
 * errored must never wipe a correct attribution.
 */
async function onlyHolderOf(deps, unit) {
  const holders = await deps.people.getOpenHoldersForUnit(String(unit)).catch(() => null);
  if (!Array.isArray(holders)) return { person: null, known: false };
  return { person: holders.length === 1 ? holders[0] : null, known: true };
}

/** One load, one verdict, one row written. */
async function checkOneLoad(order, { fleets, groupsByUnit, nowIso, deps }) {
  const load = deps.loads.extractLoadFromOrder(order);
  if (!load || !load.orderId) return null;

  const unit = load.unitNumber || null;
  const group = unit ? groupsByUnit.get(String(unit)) : null;
  // The PERSON, not the chat. A driver who changes truck or group keeps their
  // identity, and this is the column every later feature joins on — which is
  // exactly why it must be right or absent, never a guess.
  //
  // A UNIT NUMBER IS NOT A TRUCK. Company 001, Owner-Operator 001 and Lease 001
  // are three of them, and production carries ten numbers held in more than one
  // active driver group. This used `getOpenPersonForUnit`, which is
  // @deprecated precisely because it returns whichever row Postgres handed back
  // first — so a load could be stamped with the wrong human, silently, in the
  // column everything downstream joins on.
  //
  // A load carries no fleet, so the fleet cannot be supplied here. The honest
  // answer is therefore the same one `getOpenPeopleForUnits` already gives:
  // attach a person when EXACTLY ONE holds the number, and leave it null
  // otherwise. A load with no person is a load somebody can still read; a load
  // with the wrong person is a wrong answer nothing downstream can detect.
  // The contradiction itself is `identity.unit_open_twice`'s to report.
  const holder = unit
    ? await onlyHolderOf(deps, unit)
    // No unit at all is itself a certain answer: there is nobody to attach.
    : { person: null, known: true };
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
    // `personId`, NOT `id`: a driver_units ROW's `id` is the assignment, not
    // the human.
    personId: holder.person?.personId ?? null,
    // AND REMOVE ONE ALREADY THERE. The store's upsert keeps the stored person
    // when it is handed null, which is right for a read that failed and wrong
    // for a unit now known to be ambiguous: loads stamped by the old bare-unit
    // lookup would keep a wrong human forever, in the column every later
    // feature joins on. Only a read that SUCCEEDED may clear it.
    clearPerson: holder.known && !holder.person,
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

  return { state, verdict, remembered, phaseChanged: remembered ? remembered.phase !== verdict.phase : true };
}

/**
 * One pass. Never throws.
 *
 * @returns {Promise<{checked:number, changed:number, unclear:number,
 *   conflicts:number, pruned:number, providerErrors:number, skipped?:string}>}
 */
async function runLoadLifecycleCheck({ now = Date.now(), deps = defaultDeps() } = {}) {
  const summary = {
    checked: 0, changed: 0, unclear: 0,
    asked: 0, conflicts: 0, announced: 0, pruned: 0, providerErrors: 0,
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

      if (out.verdict.confidence !== 'high') summary.unclear += 1;

      if (!worthAsking(out, nowIso)) {
        keep.push(null); // nothing filed; the resolve below clears any old one
      } else {
        summary.asked += 1;
        // eslint-disable-next-line no-await-in-loop
        const filed = await deps.findings.upsertFinding(buildFinding(out.state, out.verdict))
          .catch(() => null);
        if (filed?.id) keep.push(filed.id);

        // AND TELL SOMEBODY. The `load_lifecycle` category has been
        // configurable in the admin since it was written and NOTHING EVER SENT
        // IT: this module required `notify` and never called it, so the row an
        // administrator could point at a Telegram group could not carry
        // anything. A finding on a page nobody has open is not a notice.
        //
        // Only where the sources genuinely CONTRADICT each other. A load that
        // is merely unreadable is a finding to look at when convenient; a board
        // claiming work the truck's position says did not happen is somebody's
        // afternoon.
        if (out.verdict.conflicts.length) {
          // eslint-disable-next-line no-await-in-loop
          // Optional-chained: telling somebody is observational, and a caller
          // that supplies a partial dependency map must lose the notice rather
          // than the pass. Without this a missing `notifications` throws a
          // TypeError before `.catch` can attach and abandons the remaining
          // orders mid-loop.
          const recentlySaid = await Promise.resolve(
            deps.notifications?.noticeSentWithin?.(`load:${out.state.orderId}`, REPEAT_AFTER_HOURS)
          ).catch(() => false);
          if (!recentlySaid) {
            // eslint-disable-next-line no-await-in-loop
            const sent = await Promise.resolve(deps.notify?.({
              category: 'load_lifecycle',
              title: `${out.state.unitNumber ? `Unit ${out.state.unitNumber}` : `Load ${out.state.loadIdentifier || out.state.orderId}`}`
                + ': the load board and the truck disagree',
              lines: [out.verdict.summary].filter(Boolean),
              reason: out.verdict.conflicts.join('; '),
              action: 'Check which is right — Wenze will not pick a side',
              subjectType: 'load',
              subjectId: String(out.state.orderId),
              discriminator: nowIso.slice(0, 10),
              personId: out.state.personId ?? null,
              groupId: out.state.groupId ?? null,
              evidence: {
                phase: out.verdict.phase,
                boardStatus: out.verdict.facts.boardStatus,
                conflicts: out.verdict.conflicts,
              },
            })).catch(() => ({ recorded: false }));
            if (sent?.recorded) summary.announced += 1;
          }
        }
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
    await withRunRecord('load_lifecycle', () => runLoadLifecycleCheck({}));
  } catch (err) {
    console.error('[LOADS] lifecycle tick error:', err.message);
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
  REPEAT_AFTER_HOURS,
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
