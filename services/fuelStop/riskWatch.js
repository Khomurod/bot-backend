/**
 * Watching the fleet's fuel, not just its fuel stops.
 *
 * The existing fuel feature answers one question — has this truck reached the
 * station dispatch named? — and answers it well. It cannot say whether the
 * truck can GET there, whether it drove past, or whether the instruction is
 * from last trip. Those are the questions a person actually asks.
 *
 * TWO DELIBERATE LIMITS WHILE THIS IS NEW.
 *
 * Nothing here messages a driver group. Every finding goes to the configured
 * operations chat and nowhere else. A fuel alert to a driver is an instruction,
 * and an instruction from a rule nobody has watched running yet is how a fleet
 * learns to ignore the bot. Driver messaging can be added once these have been
 * read for a few weeks and found to be right.
 *
 * And nothing here changes a record. A fuel risk is an observation, not a
 * correction: there is no state to fix, only somebody to tell.
 */
const { assessFuelRisk, RISKS } = require('../../lib/fuel/risk');
const { extractUnitFromGroupName } = require('../../lib/drivers/driverGroupTitle');

const POLL_MS = 20 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 7 * 60 * 1000;

/** How long a given risk stays quiet after being reported, in hours. */
const REPEAT_AFTER_HOURS = {
  [RISKS.LOW_FUEL]: 8,
  [RISKS.CANNOT_REACH_STOP]: 6,
  [RISKS.PASSED_STOP]: 24,
  [RISKS.INSTRUCTION_STALE]: 48,
  [RISKS.ABNORMAL_BURN]: 72,
};

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    groups: require('../../database/groups'),
    people: require('../../database/driverPeople'),
    fuel: require('../../database/fuelMonitoring'),
    eldSettings: require('../../database/eldSettings'),
    providers: require('../liveLocations/providers'),
    notifications: require('../../database/operationalNotifications'),
    notify: require('../notifications/send').notify,
  };
  /* eslint-enable global-require */
}

/**
 * The last thing we knew about this truck, for the comparisons a snapshot
 * cannot make: did it get closer to the station, and how much fuel has it used
 * over how many miles.
 *
 * Read from the open fuel watch, which already stores the distance it measured
 * last pass. Nothing new is persisted for this — a second store of positions
 * would be a position history, which this application deliberately does not keep.
 */
function previousFor(alert) {
  if (!alert) return null;
  return {
    milesToStation: alert.last_distance_miles == null ? null : Number(alert.last_distance_miles),
    fuelPercent: null,
    odometerMiles: null,
  };
}

function describe(group, unit) {
  const name = group?.group_name || '';
  const driver = name.replace(/^WENZE\s*/i, '').replace(/UNIT\s*#?\s*\d+\s*/i, '').trim();
  return `${driver || 'Driver'}${unit ? ` (Unit ${unit})` : ''}`;
}

/** One truck. Returns the risks that were actually reported. */
async function checkOneTruck(group, { fleets, alertsByGroup, nowIso, deps, options }) {
  const unit = extractUnitFromGroupName(group.group_name);
  if (!unit) return [];

  const resolved = deps.providers.resolveLocationForUnit(fleets, unit, group.group_name);
  const loc = resolved?.location;
  if (!loc || loc.lat == null) return [];

  const alertRow = alertsByGroup.get(group.id) || null;
  const alert = alertRow ? {
    stationLat: alertRow.station_lat,
    stationLng: alertRow.station_lng,
    stationName: alertRow.station_name,
    createdAt: alertRow.created_at,
  } : null;

  const { risks, facts } = assessFuelRisk({
    nowIso,
    position: {
      lat: loc.lat, lng: loc.lng, speedMph: loc.speedMph, at: loc.lastUpdated,
      fuelPercent: loc.fuelPercent ?? null, odometerMiles: loc.odometerMiles ?? null,
    },
    alert,
    previous: previousFor(alertRow),
    options,
  });
  if (!risks.length) return [];

  const person = await deps.people.getOpenPersonForUnit(String(unit)).catch(() => null);
  const who = describe(group, unit);
  const sent = [];

  for (const risk of risks) {
    // A condition that is still true tomorrow is worth saying again; the same
    // condition every twenty minutes is not. The window is per RISK KIND
    // because they age differently — a passed stop is settled history within a
    // day, a low tank matters again after a shift.
    const prefix = `fuel:group:${group.id}:${risk.kind}`;
    // eslint-disable-next-line no-await-in-loop
    const recent = await deps.notifications
      .noticeSentWithin(prefix, REPEAT_AFTER_HOURS[risk.kind] || 24)
      .catch(() => false);
    if (recent) continue;

    // eslint-disable-next-line no-await-in-loop
    const out = await deps.notify({
      category: 'fuel',
      title: `${who}: ${risk.summary}`,
      lines: [risk.detail, facts.stationName ? `Assigned stop: ${facts.stationName}` : null]
        .filter(Boolean),
      action: risk.severity === 'serious' ? 'Call the driver or reassign the stop' : null,
      subjectType: 'group',
      subjectId: group.id,
      // The window above decides whether to speak; this makes each utterance a
      // distinct row so the history reads as a sequence rather than one event.
      discriminator: `${risk.kind}:${nowIso.slice(0, 13)}`,
      personId: person?.personId ?? null,
      groupId: group.id,
      evidence: { risk: risk.kind, severity: risk.severity, ...facts },
    });
    if (out.recorded) sent.push(risk.kind);
  }
  return sent;
}

/**
 * One pass. Never throws.
 *
 * @returns {Promise<{checked:number, withFuelData:number, risks:number,
 *   reported:number, providerErrors:number}>}
 */
async function runFuelRiskCheck({ now = Date.now(), deps = defaultDeps(), options = {} } = {}) {
  const summary = { checked: 0, withFuelData: 0, risks: 0, reported: 0, providerErrors: 0 };
  const nowIso = new Date(now).toISOString();
  try {
    const cfg = await deps.eldSettings.getEldConfig();
    const fleetResult = await deps.providers.fetchProviderFleets(cfg);
    const fleets = fleetResult?.fleets || {};
    summary.providerErrors = fleetResult?.errors?.length || 0;

    const groups = await deps.groups.getDriverGroupsByActiveFilter('active').catch(() => []);
    const openAlerts = await deps.fuel.listActiveFuelStopAlerts().catch(() => []);
    const alertsByGroup = new Map(openAlerts.map((a) => [a.group_id, a]));

    for (const group of groups) {
      summary.checked += 1;
      // eslint-disable-next-line no-await-in-loop
      const reported = await checkOneTruck(group, { fleets, alertsByGroup, nowIso, deps, options })
        .catch((err) => {
          console.warn(`[FUEL-RISK] group ${group.id}:`, err.message);
          return [];
        });
      summary.reported += reported.length;
    }

    // How much of the fleet can even answer the question. Worth logging: if this
    // is zero, every silent pass is silence about nothing rather than good news.
    summary.withFuelData = countTrucksReportingFuel(fleets);
    if (summary.reported || summary.withFuelData === 0) {
      console.log(`[FUEL-RISK] ${summary.checked} trucks, ${summary.withFuelData} reporting fuel, `
        + `${summary.reported} risks sent.`);
    }
    return summary;
  } catch (err) {
    console.error('[FUEL-RISK] pass failed:', err.message);
    summary.error = err.message;
    return summary;
  }
}

/** How many vehicles in the fetched fleets report a fuel percentage at all. */
function countTrucksReportingFuel(fleets) {
  let n = 0;
  for (const list of Object.values(fleets || {})) {
    if (!Array.isArray(list)) continue;
    for (const v of list) {
      const pct = v?.fuelPercents?.value ?? v?.fuel_level;
      // `Number(null)` is 0, and `Number('')` is 0. Counting either as a reading
      // is the exact mistake this whole module exists to avoid — a truck that
      // reports no fuel would be counted as one reporting an empty tank.
      if (typeof pct !== 'number' || !Number.isFinite(pct)) continue;
      n += 1;
    }
  }
  return n;
}

let timer = null;
let stopped = false;
let tickRunning = false;

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try { await runFuelRiskCheck({}); } finally { tickRunning = false; }
}

function startFuelRiskWatch() {
  stopped = false;
  console.log(`[FUEL-RISK] Watch started — every ${POLL_MS / 60000}min`);
  setTimeout(() => { if (!stopped) tick(); }, FIRST_TICK_DELAY_MS).unref?.();
  timer = setInterval(() => { if (!stopped) tick(); }, POLL_MS);
  timer.unref?.();
}

function stopFuelRiskWatch() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  POLL_MS,
  FIRST_TICK_DELAY_MS,
  REPEAT_AFTER_HOURS,
  countTrucksReportingFuel,
  checkOneTruck,
  runFuelRiskCheck,
  startFuelRiskWatch,
  stopFuelRiskWatch,
};
