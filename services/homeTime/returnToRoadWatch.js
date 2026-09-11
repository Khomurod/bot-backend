/**
 * Watching drivers who are at home, so Wenze notices when they go back to work.
 *
 * Drivers rarely say "I am back on the road". They get a load and start
 * driving. This is the background job that reads what the company already
 * collects — the Datatruck load board and the truck's own GPS — and decides
 * how sure it is.
 *
 * COST DISCIPLINE, because this runs forever. A tick first asks the database
 * who is home; when nobody is, it makes NO provider calls at all. When someone
 * is, it fetches each fleet ONCE and the active-order window ONCE, then matches
 * locally — the same shape the Live Locations map uses — so watching sixteen
 * drivers costs the same two requests as watching one. It deliberately does not
 * build the map's full snapshot, which also geocodes and computes ETAs that
 * nothing here reads.
 *
 * IT DECIDES NOTHING BY ITSELF. It records what it saw and files a finding:
 *   high    → `home_time.returned_to_road`, which the correction registry may
 *             apply — audited, capped and revertible like every other action,
 *             and only when an administrator has switched that check on.
 *   medium  → `home_time.return_to_road_unclear`, which has NO action
 *             registered, so it can only ever be read by a person.
 *   low     → nothing, and any earlier finding is resolved.
 * Splitting the two confidences across two check keys is what makes "medium
 * never changes state" true by construction rather than by care.
 */
const { scoreReturnToRoad, milesBetweenPoints, DEFAULTS } = require('../../lib/homeTime/returnEvidence');
const { normalizeUnitNumber } = require('../samsaraLocationService');
const { extractUnitFromGroupName } = require('../../lib/drivers/driverGroupTitle');
const { withRunRecord } = require('../operations/runLedger');

const CHECK_RETURNED = 'home_time.returned_to_road';
const CHECK_UNCLEAR = 'home_time.return_to_road_unclear';

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    watch: require('../../database/homeTime/returnWatch'),
    findings: require('../../database/operationalFindings'),
    eldSettings: require('../../database/eldSettings'),
    providers: require('../liveLocations/providers'),
    orders: require('../liveLocations/orders'),
    loadService: require('../datatruckLoadService'),
    datatruck: require('../datatruckApiService'),
    reasoner: require('./returnReasoning'),
  };
  /* eslint-enable global-require */
}

/** The unit this driver's truck answers to, however the fleet spells it. */
function unitFor(driver) {
  const raw = driver.unitNumber || extractUnitFromGroupName(driver.groupName || '');
  return raw ? normalizeUnitNumber(raw) : null;
}

/** The order this driver is working, matched by unit first and name second. */
function findOrder(driver, unit, byUnit, byDriver, datatruck) {
  if (unit) {
    const hit = byUnit.get(datatruck.normalizeUnitForMatch(unit));
    if (hit) return { order: hit, matchedBy: 'unit' };
  }
  if (driver.driverName) {
    const hit = byDriver.get(datatruck.normalizeNameForMatch(driver.driverName));
    if (hit) return { order: hit, matchedBy: 'driver_name' };
  }
  return { order: null, matchedBy: null };
}

/**
 * The sightings the rules read: the one this watch already remembered, then the
 * one just taken. Two is enough — "it moved, and it was still moving later" is
 * the whole question, and keeping a longer trail would be a position history
 * this application has deliberately never had.
 */
function observationsFor(watch, current) {
  const list = [];
  if (watch?.last?.at && (!current || watch.last.at !== current.at)) list.push(watch.last);
  if (current) list.push(current);
  return list;
}

/**
 * The subject is the HOME STAY, not the driver.
 *
 * A finding is unique on (check_key, subject_type, subject_id), and
 * `upsertFinding` reopens only a RESOLVED row. Keyed on the group, the first
 * return would be applied, the row would sit at `applied` forever, and the same
 * driver's NEXT return would quietly update that row instead of becoming a new
 * event nobody acts on. The open cycle names the stay; a driver with no cycle
 * to close is identified by when they went home.
 */
function subjectFor(driver) {
  if (driver.roadHistoryId) {
    return { subjectType: 'road_history', subjectId: String(driver.roadHistoryId) };
  }
  return { subjectType: 'group', subjectId: `${driver.groupId}@${driver.homeSince || 'unknown'}` };
}

function buildFinding(driver, verdict, { unit, eventAt }) {
  const high = verdict.confidence === 'high';
  const label = `${driver.driverName || driver.groupName || `Group ${driver.groupId}`}`
    + `${unit ? ` (Unit ${unit})` : ''}`;
  return {
    checkKey: high ? CHECK_RETURNED : CHECK_UNCLEAR,
    ...subjectFor(driver),
    title: high
      ? `${label} looks back on the road — ${verdict.summary}`
      : `${label}: unclear whether they are back on the road — ${verdict.summary}`,
    severity: high ? 'info' : 'warning',
    tier: high ? 'auto' : 'warning',
    confidence: Math.max(0, Math.min(100, verdict.score)),
    evidence: {
      homeSince: driver.homeSince,
      signals: verdict.signals,
      blockers: verdict.blockers,
      ...verdict.facts,
      // WHO DECIDED, recorded beside WHAT was decided. The correction is
      // audited against this finding, so without these the trail could not say
      // whether a model was involved at all, which one, or what it said — and
      // "the software moved a driver" is exactly the claim that needs answering
      // months later. `aiAssisted: false` is written explicitly rather than
      // left absent, because an absent field reads as "nobody recorded it".
      aiAssisted: verdict.aiAssisted === true,
      aiProvider: verdict.aiProvider || null,
      aiModel: verdict.aiModel || null,
      aiConfidence: verdict.aiConfidence ?? null,
      aiReason: verdict.aiReason || null,
      decidedAutomatically: true,
    },
    proposedChange: high
      ? {
        groupId: driver.groupId,
        personId: driver.personId || null,
        cycleId: driver.roadHistoryId || null,
        returnToRoadAt: eventAt,
        evidenceSummary: verdict.summary,
      }
      : null,
  };
}

/**
 * One pass. Returns a summary; never throws.
 *
 * @returns {Promise<{checked:number, high:number, medium:number, low:number,
 *   watched:number, cleared:number, providerErrors:number, skipped?:string}>}
 */
async function runReturnToRoadCheck({ now = Date.now(), deps = defaultDeps(), options = {} } = {}) {
  const summary = {
    checked: 0, high: 0, medium: 0, low: 0, watched: 0, cleared: 0, providerErrors: 0,
  };
  const nowIso = new Date(now).toISOString();
  try {
    const drivers = await deps.watch.listDriversAtHome();
    summary.watched = drivers.length;
    // Anyone no longer home stops being watched — including a driver a person
    // moved by hand while this job was asleep.
    const cleared = await deps.watch.clearStaleWatches(drivers.map((d) => d.groupId));
    summary.cleared = cleared.length;
    if (!drivers.length) {
      // The whole point of asking the database first: no driver at home means
      // no Samsara call, no Datatruck scan, no cost.
      summary.skipped = 'nobody_home';
      return summary;
    }

    const cfg = await deps.eldSettings.getEldConfig();
    // Both of these return an ENVELOPE, not the payload: fetchProviderFleets
    // gives { fleets, errors } and getActiveOrders gives { orders, error }.
    // Passing an envelope on as if it were the thing inside it made the whole
    // pass throw on the first index and file nothing at all.
    //
    // AND THE FLEET CALL IS CAUGHT, which it was not. `getActiveOrders` beside
    // it always was; the asymmetry was an oversight, and production found it:
    // this pass reached NINETEEN consecutive failures, and the error category
    // published on /api/health named the cause as rate-limited or out of quota.
    // A 429 from a telemetry provider was killing the whole pass, every pass,
    // and it reproduced clean locally only because there is no API key locally
    // and so no quota to exceed.
    //
    // The envelope contract above says errors are RETURNED. Honouring it here
    // means a provider having a bad afternoon degrades this pass instead of
    // stopping it — and degrading is genuinely useful rather than cosmetic,
    // because a driver's return can also be evidenced by their ORDERS, which
    // arrive on a different call. `scoreReturnToRoad` already treats missing
    // GPS as a blocker rather than as proof of anything.
    const [fleetResult, orderResult] = await Promise.all([
      Promise.resolve(deps.providers.fetchProviderFleets(cfg))
        .catch((err) => ({ fleets: {}, errors: [err.message] })),
      deps.orders.getActiveOrders(now).catch(() => ({ orders: [], error: null })),
    ]);
    const fleets = fleetResult?.fleets || {};
    const orders = Array.isArray(orderResult?.orders) ? orderResult.orders : [];
    summary.providerErrors = (fleetResult?.errors?.length || 0) + (orderResult?.error ? 1 : 0);

    // NOT SILENTLY FINE. Catching the failure must not turn a pass that can see
    // nothing into a pass that reports success — that is the exact trade this
    // whole body of work exists to refuse. When no provider answered AND no
    // orders came back, the pass ran and learned nothing, and the ledger is
    // told so.
    const sawNothing = !Object.keys(fleets).length && !orders.length;
    if (sawNothing && summary.providerErrors > 0) {
      summary.error = `no telemetry and no orders could be read `
        + `(${summary.providerErrors} provider error(s))`;
    }
    const byUnit = deps.orders.indexOrdersByUnit(orders, now);
    const byDriver = deps.orders.indexOrdersByDriver(orders, now);

    const keepIds = [];
    for (const driver of drivers) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await checkOneDriver(driver, {
        fleets, byUnit, byDriver, nowIso, now, deps, options,
      });
      summary.checked += 1;
      summary[outcome.confidence] += 1;
      if (outcome.findingId) keepIds.push(outcome.findingId);
    }

    // Everything this pass did NOT re-file is no longer true.
    await deps.findings.resolveClearedFindings([CHECK_RETURNED, CHECK_UNCLEAR], keepIds);
  } catch (err) {
    console.error('[HOME-TIME-RETURN] check failed:', err.message);
    summary.error = err.message;
  }
  return summary;
}

async function checkOneDriver(driver, { fleets, byUnit, byDriver, nowIso, now, deps, options }) {
  const unit = unitFor(driver);
  await deps.watch.ensureWatch({
    groupId: driver.groupId,
    personId: driver.personId,
    roadHistoryId: driver.roadHistoryId,
    homeSince: driver.homeSince,
  });
  const watch = await deps.watch.getWatch(driver.groupId);

  // Where the truck is. An ambiguous unit resolves to nothing on purpose —
  // plotting the wrong truck is worse than plotting none.
  const resolved = unit
    ? deps.providers.resolveLocationForUnit(fleets, unit, driver.driverName)
    : { location: null };
  const loc = resolved?.location || null;
  const current = loc && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng))
    ? {
      lat: Number(loc.lat),
      lng: Number(loc.lng),
      speedMph: loc.speedMph == null ? null : Number(loc.speedMph),
      at: loc.lastUpdated || nowIso,
    }
    : null;

  const { order } = findOrder(driver, unit, byUnit, byDriver, deps.datatruck);
  const load = order ? deps.loadService.extractLoadFromOrder(order) : null;

  const opts = { ...DEFAULTS, ...options };
  const moving = current != null && Number(current.speedMph) > opts.parkedSpeedMph;
  const milesFromAnchor = watch?.anchor && current
    ? milesBetweenPoints(watch.anchor, current) : null;

  // The anchor is the truck's parked position while the driver is home. Only a
  // STATIONARY sighting may set it: anchoring mid-drive would put "home" on an
  // interstate and make every later comparison meaningless.
  const anchorEligible = Boolean(current) && !moving && !watch?.anchor;

  const stored = await deps.watch.recordObservation(driver.groupId, {
    lat: current?.lat ?? null,
    lng: current?.lng ?? null,
    speedMph: current?.speedMph ?? null,
    seenAt: current?.at ?? null,
    checkedAt: nowIso,
    milesFromAnchor,
    moving,
    anchorEligible,
    anchorSource: anchorEligible ? 'live_gps' : null,
    load: load ? { loadIdentifier: load.loadIdentifier, status: load.status, pickupTime: load.pickupTime } : null,
  });

  const anchor = stored?.anchor || watch?.anchor || null;
  let verdict = scoreReturnToRoad({
    nowIso,
    load,
    anchor,
    observations: observationsFor(watch, current),
    // What this stay has seen before now. Two sightings cannot show that a
    // truck drove sixty miles out last night; the watch row can.
    remembered: {
      maxMilesFromAnchor: stored?.maxMilesFromAnchor ?? watch?.maxMilesFromAnchor ?? null,
      movingSightings: stored?.movingSightings ?? watch?.movingSightings ?? 0,
    },
    options,
  });

  // AI may only make a MEDIUM case clearer — never invent one. It is asked at
  // most once per driver per pass, and only when the deterministic evidence is
  // already ambiguous.
  if (verdict.confidence === 'medium' && deps.reasoner?.reviewReturnEvidence) {
    const homeHours = driver.homeSince
      ? Math.round((Date.parse(nowIso) - Date.parse(driver.homeSince)) / 3600000)
      : null;
    const reviewed = await deps.reasoner.reviewReturnEvidence({ verdict, load, homeHours })
      .catch(() => null);
    if (reviewed) verdict = reviewed;
  }

  await deps.watch.recordObservation(driver.groupId, {
    checkedAt: nowIso,
    confidence: verdict.confidence,
    score: verdict.score,
    signals: { signals: verdict.signals, blockers: verdict.blockers, facts: verdict.facts },
  });

  if (verdict.confidence === 'low') return { confidence: 'low', findingId: null };

  const eventAt = current?.at || nowIso;
  const filed = await deps.findings.upsertFinding(buildFinding(driver, verdict, { unit, eventAt }));
  return { confidence: verdict.confidence, findingId: filed?.id || null };
}

// ── the background job ───────────────────────────────────────────────────────
//
// Twelve minutes, because that is the resolution the answer needs: a driver who
// left an hour ago is still news, and checking every minute would multiply the
// provider cost for nothing. The first pass waits four minutes so a deploy
// settles first.
const POLL_MS = 12 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 4 * 60 * 1000;

let serviceTimer = null;
let serviceStopped = false;
let tickRunning = false;

async function tick() {
  // Skipped, never queued: a pass that overruns has already read the state the
  // next one would read, and two passes filing the same finding race for it.
  if (tickRunning) return;
  tickRunning = true;
  try {
    const summary = await withRunRecord('return_to_road', () => runReturnToRoadCheck({}));
    if (summary.high || summary.medium || summary.error) {
      console.log(`[HOME-TIME-RETURN] ${summary.checked} at home checked — `
        + `${summary.high} look back on the road, ${summary.medium} unclear`
        + `${summary.error ? ` (error: ${summary.error})` : ''}.`);
    }
  } catch (err) {
    console.error('[HOME-TIME-RETURN] tick error:', err.message);
  } finally {
    tickRunning = false;
    if (!serviceStopped) {
      serviceTimer = setTimeout(tick, POLL_MS);
      serviceTimer.unref?.();
    }
  }
}

function startReturnToRoadWatch() {
  serviceStopped = false;
  console.log(`[HOME-TIME-RETURN] Watching drivers at home every ${POLL_MS / 60000} min `
    + '— a load alone is never a departure.');
  serviceTimer = setTimeout(() => { if (!serviceStopped) tick(); }, FIRST_TICK_DELAY_MS);
  serviceTimer.unref?.();
}

function stopReturnToRoadWatch() {
  serviceStopped = true;
  if (serviceTimer) { clearTimeout(serviceTimer); serviceTimer = null; }
}

module.exports = {
  subjectFor,
  POLL_MS,
  FIRST_TICK_DELAY_MS,
  startReturnToRoadWatch,
  stopReturnToRoadWatch,
  CHECK_RETURNED,
  CHECK_UNCLEAR,
  defaultDeps,
  unitFor,
  findOrder,
  observationsFor,
  buildFinding,
  checkOneDriver,
  runReturnToRoadCheck,
};
