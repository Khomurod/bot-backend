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
const { planFuelStop, priorityFactsFor } = require('../../lib/fuel/planning');
const { extractUnitFromGroupName } = require('../../lib/drivers/driverGroupTitle');
const { withRunRecord } = require('../operations/runLedger');

const POLL_MS = 20 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 7 * 60 * 1000;

/**
 * How long a given risk stays quiet after being reported, in hours.
 *
 * THESE ARE PER-RISK FLOORS, not the whole answer. `notification_settings`
 * carries an operator-set `repeat_after_hours` that was read by nothing at all
 * — a slider in the admin that moved no behaviour. It is now the value each of
 * these is measured against: a fleet that wants everything quieter raises it
 * once, and a passed stop still ages faster than a low tank because the shape
 * below is about the RISK, not about taste.
 */
const REPEAT_AFTER_HOURS = {
  [RISKS.LOW_FUEL]: 8,
  [RISKS.CANNOT_REACH_STOP]: 6,
  [RISKS.PASSED_STOP]: 24,
  [RISKS.INSTRUCTION_STALE]: 48,
  [RISKS.ABNORMAL_BURN]: 72,
};

/**
 * The two risks the reachability plan is actually about.
 *
 * `planFuelStop` answers one question — can this truck get to the stop it was
 * given — so it belongs on the low tank and the unreachable stop. Attaching it
 * to a passed stop or a stale instruction would be a sentence about range
 * printed under a notice about neither, which is how supporting lines stop
 * being read.
 */
const PLAN_APPLIES_TO = new Set([RISKS.LOW_FUEL, RISKS.CANNOT_REACH_STOP]);

/**
 * The quiet window for one risk kind.
 *
 * The operator's setting is a CEILING on how often anything repeats, so a
 * fleet that raised it to a week does not still hear about a low tank every
 * eight hours. Below the default it has no effect: a passed stop settling
 * within a day is a property of the event, not a preference.
 */
function repeatHoursFor(kind, configuredHours = null) {
  const base = REPEAT_AFTER_HOURS[kind] || 24;
  const configured = Number(configuredHours);
  if (!Number.isFinite(configured) || configured <= 0) return base;
  return Math.max(base, configured);
}

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    groups: require('../../database/groups'),
    people: require('../../database/driverPeople'),
    fuel: require('../../database/fuelMonitoring'),
    readings: require('../../database/truckFuelReadings'),
    eldSettings: require('../../database/eldSettings'),
    providers: require('../liveLocations/providers'),
    notifications: require('../../database/operationalNotifications'),
    notificationSettings: require('../../database/operationalNotificationSettings'),
    notify: require('../notifications/send').notify,
  };
  /* eslint-enable global-require */
}

/**
 * The last thing we knew about this truck, for the comparisons a snapshot
 * cannot make: did it get closer to the station, and how much fuel has it used
 * over how many miles.
 *
 * TWO SOURCES, because they answer two different questions. The distance comes
 * from the open fuel watch, which already stored what it measured last pass.
 * The fuel and odometer come from `truck_fuel_readings` — and until that table
 * existed THIS FUNCTION RETURNED `fuelPercent: null, odometerMiles: null`
 * HARD-CODED, which made `assessFuelRisk`'s abnormal-burn branch unreachable
 * for the whole life of the feature. It looked implemented and could not fire.
 *
 * `baseline` is null far more often than not, and that is correct: comparing
 * two readings twenty minutes apart measures noise, and comparing across a
 * fill-up measures nothing at all. See `database/truckFuelReadings.js`.
 */
function previousFor(alert, baseline = null) {
  const milesToStation = alert && alert.last_distance_miles != null
    ? Number(alert.last_distance_miles)
    : null;
  if (milesToStation == null && !baseline) return null;
  return {
    milesToStation,
    fuelPercent: baseline?.fuelPercent ?? null,
    odometerMiles: baseline?.odometerMiles ?? null,
  };
}

function describe(group, unit) {
  const name = group?.group_name || '';
  const driver = name.replace(/^WENZE\s*/i, '').replace(/UNIT\s*#?\s*\d+\s*/i, '').trim();
  return `${driver || 'Driver'}${unit ? ` (Unit ${unit})` : ''}`;
}

/** One truck. Returns the risks that were actually reported. */
async function checkOneTruck(group, {
  fleets, alertsByGroup, nowIso, deps, options, peopleByUnit = new Map(),
}) {
  const unit = extractUnitFromGroupName(group.group_name);
  if (!unit) return [];

  const resolved = deps.providers.resolveLocationForUnit(fleets, unit, group.group_name);
  const loc = resolved?.location;
  if (!loc || loc.lat == null) return [];

  const personId = peopleByUnit.get(String(unit)) ?? null;

  // Written BEFORE the assessment, and the assessment reads what it returns.
  // The write is what makes the next pass able to answer at all, so it must
  // happen even on a pass that reports nothing.
  const reading = await deps.readings.recordAndCompare({
    unitNumber: String(unit),
    personId,
    groupId: group.id,
    fuelPercent: loc.fuelPercent ?? null,
    odometerMiles: loc.odometerMiles ?? null,
    recordedAt: loc.lastUpdated || nowIso,
  }).catch(() => ({ previous: null }));

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
    previous: previousFor(alertRow, reading?.previous || null),
    options,
  });
  if (!risks.length) return [];

  // CAN IT GET THERE, phrased for a person and rounded to what a range estimate
  // is actually worth. `assessFuelRisk` decides THAT the stop is out of reach;
  // this says by how much and, deliberately, names no alternative station —
  // Wenze has no database of truck-accessible stops, and a confident wrong
  // suggestion about where to fuel a truck four hundred miles out is worse than
  // a clear statement of the problem.
  const plan = planFuelStop({
    rangeMiles: facts.rangeMiles,
    milesToStation: facts.milesToStation,
    stationName: facts.stationName,
  });

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
      .noticeSentWithin(prefix, repeatHoursFor(risk.kind, options.repeatAfterHours))
      .catch(() => false);
    if (recent) continue;

    // eslint-disable-next-line no-await-in-loop
    const out = await deps.notify({
      category: 'fuel',
      title: `${who}: ${risk.summary}`,
      lines: [
        risk.detail,
        PLAN_APPLIES_TO.has(risk.kind) && plan.known ? plan.advice : null,
        facts.stationName ? `Assigned stop: ${facts.stationName}` : null,
      ].filter(Boolean),
      action: risk.severity === 'serious' ? 'Call the driver or reassign the stop' : null,
      // THIS risk's severity, not the category's. `fuel` is catalogued as a
      // warning, which is right for a truck at 28% twenty miles from a station
      // and wrong for one that cannot reach its stop at all — and the second is
      // the one that costs money.
      severity: risk.severity,
      // The same numbers the advice above was written from, so what a notice
      // is prioritised by and what it says cannot drift apart.
      facts: priorityFactsFor(plan),
      subjectType: 'group',
      subjectId: group.id,
      // The window above decides whether to speak; this makes each utterance a
      // distinct row so the history reads as a sequence rather than one event.
      discriminator: `${risk.kind}:${nowIso.slice(0, 13)}`,
      personId,
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
    // The operator's ceiling on how often anything repeats. Read once per pass,
    // not per truck, and a failure leaves the per-risk defaults standing.
    const notifySettings = await Promise.resolve(
      deps.notificationSettings?.getNotificationSettings?.()
    ).catch(() => null);
    const passOptions = {
      ...options,
      repeatAfterHours: options.repeatAfterHours ?? notifySettings?.repeatAfterHours ?? null,
    };

    const cfg = await deps.eldSettings.getEldConfig();
    const fleetResult = await deps.providers.fetchProviderFleets(cfg);
    const fleets = fleetResult?.fleets || {};
    summary.providerErrors = fleetResult?.errors?.length || 0;

    const groups = await deps.groups.getDriverGroupsByActiveFilter('active').catch(() => []);
    const openAlerts = await deps.fuel.listActiveFuelStopAlerts().catch(() => []);
    const alertsByGroup = new Map(openAlerts.map((a) => [a.group_id, a]));

    // ONE query for the whole fleet's identities. This used to be one lookup
    // per truck inside the loop below — about 110 round trips every twenty
    // minutes to answer a question a single `= ANY` settles.
    const units = groups
      .map((g) => extractUnitFromGroupName(g.group_name))
      .filter(Boolean)
      .map(String);
    const peopleByUnit = await deps.people.getOpenPeopleForUnits(units).catch(() => new Map());

    for (const group of groups) {
      summary.checked += 1;
      // eslint-disable-next-line no-await-in-loop
      const reported = await checkOneTruck(group, {
        fleets, alertsByGroup, nowIso, deps, options: passOptions, peopleByUnit,
      })
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
  try {
    await withRunRecord('fuel_risk', () => runFuelRiskCheck({}));
  } catch (err) {
    console.error('[FUEL-RISK] tick error:', err.message);
  } finally {
    tickRunning = false;
  }
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
  PLAN_APPLIES_TO,
  repeatHoursFor,
  countTrucksReportingFuel,
  checkOneTruck,
  runFuelRiskCheck,
  startFuelRiskWatch,
  stopFuelRiskWatch,
};
