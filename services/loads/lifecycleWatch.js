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
const {
  CHECK_UNCLEAR, buildFinding, buildNotice, worthAsking,
} = require('../../lib/loads/lifecycleReport');
const {
  extractUnitFromGroupName, extractDriverNameFromGroupTitle,
} = require('../../lib/drivers/driverGroupTitle');
const { noticeKeyFor } = require('../../lib/notifications/compose');
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
/** Where a load notice is routed. Spelled out again at the `notify()` call. */
const LOAD_CATEGORY = 'load_lifecycle';

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
    reviewAlarm: require('./alarmReview').reviewLoadAlarm,
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
async function checkOneLoad(order, {
  fleets, groupsByUnit, ambiguousUnits = new Set(), nowIso, deps,
}) {
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
      ? {
        phase: remembered.phase,
        wasAtPickup: remembered.wasAtPickup,
        wasAtDelivery: remembered.wasAtDelivery,
        // When THIS stay at the shipper began — what tells a truck being
        // loaded from one that has stood there for hours. The phase start,
        // not `first_at_pickup_at`: that is the first visit ever and is kept
        // forever, so a truck that left and came back would read as having
        // stood there since its first visit. Leaving changes the phase, and
        // returning starts a new `phase_since`.
        atPickupSince: remembered.phase === PHASES.AT_PICKUP ? (remembered.phaseSince || null) : null,
      }
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

  return {
    state, verdict, remembered,
    // A NAME ONLY WHEN THE UNIT IS UNAMBIGUOUS. `groupsByUnit` keeps the first
    // of several groups sharing a number, which is fine for a position lookup
    // and wrong for saying WHO: naming that group's driver would pin the
    // disagreement on somebody who may not be carrying this load. The same
    // rule the person attribution above follows.
    driverName: group && holder.person && !ambiguousUnits.has(String(unit))
      ? (extractDriverNameFromGroupTitle(group.group_name) || null)
      : null,
    phaseChanged: remembered ? remembered.phase !== verdict.phase : true,
  };
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
    asked: 0, conflicts: 0, announced: 0, heldByAi: 0, pruned: 0, providerErrors: 0,
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
    const ambiguousUnits = new Set();
    const groups = await deps.groups.getDriverGroupsByActiveFilter('active').catch(() => []);
    for (const g of groups) {
      const unit = extractUnitFromGroupName(g.group_name);
      if (unit && groupsByUnit.has(String(unit))) ambiguousUnits.add(String(unit));
      // First one wins. A unit on two active groups is a real condition in this
      // fleet — `identity.duplicate_unit` already files it for a person — and
      // picking the later row here would make a load's driver depend on the
      // order a SELECT happened to return.
      if (unit && !groupsByUnit.has(String(unit))) groupsByUnit.set(String(unit), g);
    }

    const keep = [];
    for (const order of orders) {
      // eslint-disable-next-line no-await-in-loop
      const out = await checkOneLoad(order, {
        fleets, groupsByUnit, ambiguousUnits, nowIso, deps,
      }).catch((err) => {
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

        // AND TELL SOMEBODY — only where the sources genuinely contradict each
        // other, or the load's own addresses are unusable. A load that is merely
        // unreadable is a finding to look at when convenient; a board claiming
        // work the truck's position says did not happen is somebody's afternoon.
        const notice = buildNotice(out, out.driverName);
        // An address problem is said once per load, ever; a disagreement at
        // most once a day.
        const isAddress = notice?.subjectType === 'load_address';
        let recentlySaid = false;
        let review = null;
        if (notice && !isAddress) {
          // The REAL key prefix. This read `load:<id>`, which no notice key has
          // ever started with — they start with the category — so the guard
          // never matched and only the per-day key kept repeats down. The
          // trailing colon stops order 12 matching order 123.
          const prefix = `${noticeKeyFor(LOAD_CATEGORY, notice.subjectType, notice.subjectId)}:`;
          // Optional-chained: telling somebody is observational, and a caller
          // that supplies a partial dependency map must lose the notice rather
          // than the pass.
          // eslint-disable-next-line no-await-in-loop
          recentlySaid = await Promise.resolve(
            deps.notifications?.noticeSentWithin?.(prefix, REPEAT_AFTER_HOURS)
          ).catch(() => false);
          // A SECOND OPINION before the chat hears it (`lib/loads/alarmReview.js`).
          // It can only keep a notice out of the chat, and only on a confident
          // "likely bad data"; the finding below is filed either way.
          if (!recentlySaid) {
            // eslint-disable-next-line no-await-in-loop
            review = await Promise.resolve(deps.reviewAlarm?.(out, nowIso)).catch(() => null);
          }
        }

        const finding = buildFinding(out.state, out.verdict, out.driverName);
        if (review?.review) finding.evidence.aiReview = review.review;
        // eslint-disable-next-line no-await-in-loop
        const filed = await deps.findings.upsertFinding(finding).catch(() => null);
        if (filed?.id) keep.push(filed.id);

        if (notice && !recentlySaid && review?.send === false) summary.heldByAi += 1;
        if (notice && !recentlySaid && review?.send !== false) {
          // eslint-disable-next-line no-await-in-loop
          const sent = await Promise.resolve(deps.notify?.({
            category: 'load_lifecycle',
            ...notice,
            lines: [...(notice.lines || []), review?.line].filter(Boolean),
            discriminator: isAddress ? null : nowIso.slice(0, 10),
          })).catch(() => ({ recorded: false }));
          if (sent?.recorded) summary.announced += 1;
        }
      }
    }

    // A load that became clear stops being a question.
    await deps.findings.resolveClearedFindings([CHECK_UNCLEAR], keep.filter(Boolean)).catch(() => {});

    // A LOAD THE BOARD STOPPED RETURNING IS FINISHED. Only on a read that
    // succeeded: `getActiveOrders` hands back the LAST GOOD order set with an
    // error when a fetch fails, and retiring against a stale list would retire
    // whatever was booked since. Optional-chained so a partial dependency map
    // costs the retirement and never the pass.
    if (!orderResult?.error) {
      // The SAME extraction `checkOneLoad` keys its rows by, so "seen" means
      // exactly what "recorded" means — a different reading of the order id
      // here would retire every load the board is still returning.
      const seen = orders.map((o) => {
        try { return deps.loads.extractLoadFromOrder(o)?.orderId ?? null; } catch (_) { return null; }
      }).filter((id) => id != null).map(String);
      const retired = await Promise.resolve(deps.store.retireMissingLoads?.(seen)).catch(() => null);
      summary.retired = retired?.retired || 0;
    }
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
  buildNotice,
  checkOneLoad,
  runLoadLifecycleCheck,
  startLoadLifecycleWatch,
  stopLoadLifecycleWatch,
};
