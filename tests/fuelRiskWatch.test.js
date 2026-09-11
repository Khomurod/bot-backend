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
  alerts = [], recent = false,
} = {}) {
  const calls = { notified: [], windows: [], fleets: 0 };
  const deps = {
    groups: { async getDriverGroupsByActiveFilter() { return groups; } },
    people: { async getOpenPersonForUnit() { return { personId: 11 }; } },
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
