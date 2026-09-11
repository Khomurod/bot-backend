/**
 * The fuel-risk pass, with the fleet and the watch table replaced.
 *
 * Two promises that matter more than the arithmetic:
 *
 *   NOTHING REACHES A DRIVER. Every finding goes to the operations chat while
 *   this is new. A fuel alert to a driver is an instruction, and an instruction
 *   from a rule nobody has watched running is how a fleet learns to ignore the
 *   bot.
 *
 *   THE SAME RISK IS NOT REPEATED EVERY TWENTY MINUTES. A condition that is
 *   still true tomorrow is worth saying again; the same one four times an hour
 *   is how a channel becomes unread.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const watcher = require('../services/fuelStop/riskWatch');

const NOW = Date.parse('2026-09-20T18:00:00Z');
const at = (mins) => new Date(NOW - mins * 60000).toISOString();

function harness({
  groups = [{ id: 7, group_name: 'WENZE UNIT # 310 JOHN DOE' }],
  location = { lat: 41, lng: -87, speedMph: 60 },
  alerts = [], recent = false, baseline = null,
} = {}) {
  const calls = { notified: [], windows: [], fleets: 0, readings: [] };
  const deps = {
    groups: { async getDriverGroupsByActiveFilter() { return groups; } },
    people: {
      async getOpenPeopleForUnits(units) { return new Map(units.map((u) => [u, 11])); },
    },
    readings: {
      async recordAndCompare(reading) {
        calls.readings.push(reading);
        return { previous: baseline, reason: baseline ? 'comparable' : 'accumulating' };
      },
    },
    fuel: { async listActiveFuelStopAlerts() { return alerts; } },
    eldSettings: { async getEldConfig() { return { samsaraEnabled: true }; } },
    providers: {
      async fetchProviderFleets() {
        calls.fleets += 1;
        return { fleets: { samsara: [{ fuelPercents: { value: 42 } }] }, errors: [] };
      },
      resolveLocationForUnit() {
        return { location: location ? { ...location, lastUpdated: location.at || at(5) } : null };
      },
    },
    notifications: {
      async noticeSentWithin(prefix, hours) { calls.windows.push({ prefix, hours }); return recent; },
    },
    async notify(n) { calls.notified.push(n); return { recorded: true, delivered: true }; },
  };
  return { deps, calls };
}

const LOW = { lat: 41, lng: -87, speedMph: 60, fuelPercent: 6 };

// ── nothing reaches a driver ─────────────────────────────────────────────────

test('every finding is routed to the operations chat, never to a driver group', async () => {
  const { deps, calls } = harness({ location: LOW });
  await watcher.runFuelRiskCheck({ now: NOW, deps });
  assert.equal(calls.notified.length, 1);
  assert.equal(calls.notified[0].category, 'fuel',
    'the fuel category, whose destination an administrator configures — not a driver chat');
});

test('the notice names the driver and the unit, so it can be acted on', async () => {
  const { deps, calls } = harness({ location: LOW });
  await watcher.runFuelRiskCheck({ now: NOW, deps });
  assert.match(calls.notified[0].title, /JOHN DOE \(Unit 310\)/);
  assert.match(calls.notified[0].title, /fuel at 6%/);
  assert.equal(calls.notified[0].personId, 11, 'and it follows the person, not the chat');
});

test('a serious risk says what to do; a mild one does not invent an instruction', async () => {
  const serious = harness({ location: LOW });
  await watcher.runFuelRiskCheck({ now: NOW, deps: serious.deps });
  assert.match(serious.calls.notified[0].action, /Call the driver/);

  const mild = harness({
    location: { lat: 41, lng: -87, speedMph: 60, fuelPercent: 40, odometerMiles: 100200 },
    alerts: [{
      group_id: 7, station_lat: 41.2, station_lng: -87, station_name: 'Pilot 442',
      created_at: at(60 * 40), last_distance_miles: 4,
    }],
  });
  await watcher.runFuelRiskCheck({ now: NOW, deps: mild.deps });
  const infoOnes = mild.calls.notified.filter((n) => n.action == null);
  assert.ok(infoOnes.length > 0, 'an informational risk is reported without a command');
});

// ── it does not repeat itself ────────────────────────────────────────────────

test('a risk reported recently stays quiet', async () => {
  const { deps, calls } = harness({ location: LOW, recent: true });
  const summary = await watcher.runFuelRiskCheck({ now: NOW, deps });
  assert.equal(calls.notified.length, 0);
  assert.equal(summary.reported, 0);
});

test('the quiet window is per RISK KIND, because they age differently', async () => {
  const { deps, calls } = harness({
    location: { ...LOW, odometerMiles: 100200 },
    alerts: [{
      group_id: 7, station_lat: 44.05, station_lng: -87, station_name: 'Pilot 442',
      created_at: at(60 * 40), last_distance_miles: 10,
    }],
  });
  await watcher.runFuelRiskCheck({ now: NOW, deps });
  const kinds = calls.windows.map((w) => w.prefix.split(':').pop());
  assert.ok(kinds.includes('low_fuel'));
  assert.ok(kinds.includes('cannot_reach_stop'));
  // A passed stop is settled history within a day; a low tank matters again
  // after a shift. One window for both would be wrong in one direction.
  const byKind = Object.fromEntries(calls.windows.map((w) => [w.prefix.split(':').pop(), w.hours]));
  assert.notEqual(byKind.low_fuel, byKind.instruction_stale);
});

test('the key names the group AND the kind, so two trucks do not silence each other', async () => {
  const { deps, calls } = harness({
    location: LOW,
    groups: [
      { id: 7, group_name: 'WENZE UNIT # 310 JOHN DOE' },
      { id: 8, group_name: 'WENZE UNIT # 311 JANE ROE' },
    ],
  });
  await watcher.runFuelRiskCheck({ now: NOW, deps });
  assert.equal(calls.notified.length, 2);
  assert.notEqual(calls.notified[0].subjectId, calls.notified[1].subjectId);
});

// ── absence is silence, end to end ───────────────────────────────────────────

test('a fleet reporting no fuel at all produces no notices', async () => {
  const { deps, calls } = harness({ location: { lat: 41, lng: -87, speedMph: 60 } });
  const summary = await watcher.runFuelRiskCheck({ now: NOW, deps });
  assert.equal(calls.notified.length, 0);
  assert.equal(summary.checked, 1, 'the truck was looked at');
  assert.equal(summary.reported, 0, 'and had nothing to say');
});

test('how much of the fleet can answer the question at all is counted', async () => {
  const { deps } = harness({ location: LOW });
  const summary = await watcher.runFuelRiskCheck({ now: NOW, deps });
  // A silent pass over a fleet where NOTHING reports fuel is silence about
  // nothing, not good news, and the log has to be able to tell them apart.
  assert.equal(summary.withFuelData, 1);
});

test('the fuel counter reads both provider shapes and ignores the rest', () => {
  const n = watcher.countTrucksReportingFuel({
    samsara: [{ fuelPercents: { value: 42 } }, { gps: {} }],
    factor: [{ fuel_level: 88 }, { fuel_level: null }],
    leader: null,
  });
  assert.equal(n, 2);
});

// ── cost and failure ─────────────────────────────────────────────────────────

test('one fleet fetch per pass, however many trucks', async () => {
  const { deps, calls } = harness({
    location: LOW,
    groups: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, group_name: `WENZE UNIT # ${300 + i} D` })),
  });
  await watcher.runFuelRiskCheck({ now: NOW, deps });
  assert.equal(calls.fleets, 1);
});

test('a group with no unit in its title is skipped, not guessed at', async () => {
  const { deps, calls } = harness({
    location: LOW, groups: [{ id: 7, group_name: 'Employee Feedback (Admin)' }],
  });
  await watcher.runFuelRiskCheck({ now: NOW, deps });
  assert.equal(calls.notified.length, 0);
});

test('one truck that throws does not stop the pass', async () => {
  const { deps, calls } = harness({
    location: LOW,
    groups: [
      { id: 7, group_name: 'WENZE UNIT # 310 JOHN DOE' },
      { id: 8, group_name: 'WENZE UNIT # 311 JANE ROE' },
    ],
  });
  let n = 0;
  const realResolve = deps.providers.resolveLocationForUnit;
  deps.providers.resolveLocationForUnit = (...args) => {
    n += 1;
    if (n === 1) throw new Error('provider blew up');
    return realResolve(...args);
  };
  const summary = await watcher.runFuelRiskCheck({ now: NOW, deps });
  assert.equal(summary.checked, 2);
  assert.equal(calls.notified.length, 1);
});

test('a provider outage is counted and the pass still completes', async () => {
  const { deps } = harness({ location: LOW });
  deps.providers.fetchProviderFleets = async () => ({ fleets: {}, errors: [{ provider: 'samsara' }] });
  const summary = await watcher.runFuelRiskCheck({ now: NOW, deps });
  assert.equal(summary.providerErrors, 1);
});

// ── the abnormal-burn branch, which could not fire at all ────────────────────
//
// `previousFor` returned `fuelPercent: null, odometerMiles: null` HARD-CODED,
// so `assessFuelRisk`'s abnormal-consumption branch was unreachable for the
// whole life of the feature. These three fail against that code.

test('a truck burning abnormally is reported once there is a real window to compare', async () => {
  const { deps, calls } = harness({
    location: { lat: 41, lng: -87, speedMph: 60, fuelPercent: 40, odometerMiles: 100200 },
    baseline: { fuelPercent: 95, odometerMiles: 100000 },
  });
  await watcher.runFuelRiskCheck({ now: NOW, deps });
  const burn = calls.notified.find((n) => n.evidence?.risk === 'abnormal_burn');
  assert.ok(burn, '55 points over 200 miles is 27.5% per 100, past the 22% default');
  assert.equal(burn.evidence.severity, 'info',
    'a consumption observation is not an emergency; it is something to look at');
});

test('with no comparable window nothing is claimed about consumption', async () => {
  const { deps, calls } = harness({
    location: { lat: 41, lng: -87, speedMph: 60, fuelPercent: 40, odometerMiles: 100200 },
    baseline: null,
  });
  await watcher.runFuelRiskCheck({ now: NOW, deps });
  assert.equal(calls.notified.filter((n) => n.evidence?.risk === 'abnormal_burn').length, 0);
});

test('the reading is stored on every pass, including a silent one', async () => {
  const { deps, calls } = harness({
    location: { lat: 41, lng: -87, speedMph: 60, fuelPercent: 88, odometerMiles: 100300 },
  });
  await watcher.runFuelRiskCheck({ now: NOW, deps });
  assert.equal(calls.notified.length, 0, 'an 88% tank is nobody’s problem');
  assert.equal(calls.readings.length, 1,
    'but the write is what makes the NEXT pass able to answer, so it cannot be skipped');
  assert.equal(calls.readings[0].unitNumber, '310');
  assert.equal(calls.readings[0].personId, 11, 'and the history follows the person');
  assert.equal(calls.readings[0].fuelPercent, 88);
});

test('a truck whose provider reports no fuel stores UNKNOWN, not zero', async () => {
  const { deps, calls } = harness({
    location: { lat: 41, lng: -87, speedMph: 60 },
  });
  await watcher.runFuelRiskCheck({ now: NOW, deps });
  assert.equal(calls.readings[0].fuelPercent, null);
  assert.equal(calls.readings[0].odometerMiles, null);
  assert.equal(calls.notified.length, 0, 'and a missing tank level is never a low tank');
});

test('the fleet’s identities are resolved in ONE query, not one per truck', async () => {
  const groups = Array.from({ length: 40 }, (_, i) => ({
    id: 100 + i, group_name: `WENZE UNIT # ${400 + i} DRIVER ${i}`,
  }));
  let lookups = 0;
  const { deps } = harness({ groups });
  const inner = deps.people.getOpenPeopleForUnits;
  deps.people.getOpenPeopleForUnits = async (units) => { lookups += 1; return inner(units); };
  await watcher.runFuelRiskCheck({ now: NOW, deps });
  assert.equal(lookups, 1, '40 trucks, one lookup — this used to be 40 round trips');
});

// ── the operator's repeat setting, which used to move nothing ───────────────

test('the configured repeat window RAISES the quiet period; it never lowers a floor', () => {
  // `notification_settings.repeat_after_hours` is writable from the admin,
  // clamped by the schema, and was read by nothing at all — a slider that moved
  // no behaviour. It is a CEILING on how often anything repeats: a fleet that
  // wants everything quieter raises it once.
  assert.equal(watcher.repeatHoursFor('low_fuel'), 8, 'the per-risk default');
  assert.equal(watcher.repeatHoursFor('low_fuel', 168), 168, 'a quieter fleet is obeyed');
  assert.equal(watcher.repeatHoursFor('passed_stop', 4), 24,
    'but a passed stop settling within a day is a property of the event, not a taste');
  assert.equal(watcher.repeatHoursFor('low_fuel', 0), 8, 'nonsense leaves the default standing');
  assert.equal(watcher.repeatHoursFor('unknown_kind'), 24);
});

test('the setting reaches the quiet-window check', async () => {
  const { deps, calls } = harness({ location: LOW });
  deps.notificationSettings = {
    async getNotificationSettings() { return { repeatAfterHours: 200 }; },
  };
  await watcher.runFuelRiskCheck({ now: NOW, deps });
  assert.equal(calls.windows[0].hours, 200);
});

test('it is read ONCE per pass, not once per truck', async () => {
  const groups = Array.from({ length: 12 }, (_, i) => ({
    id: 200 + i, group_name: `WENZE UNIT # ${500 + i} DRIVER ${i}`,
  }));
  let reads = 0;
  const { deps } = harness({ groups, location: LOW });
  deps.notificationSettings = {
    async getNotificationSettings() { reads += 1; return { repeatAfterHours: 48 }; },
  };
  await watcher.runFuelRiskCheck({ now: NOW, deps });
  assert.equal(reads, 1);
});

test('no settings at all leaves the per-risk defaults standing', async () => {
  const { deps, calls } = harness({ location: LOW });
  delete deps.notificationSettings;
  await watcher.runFuelRiskCheck({ now: NOW, deps });
  assert.equal(calls.windows[0].hours, 8, 'a failed settings read must not silence the fleet');
});
