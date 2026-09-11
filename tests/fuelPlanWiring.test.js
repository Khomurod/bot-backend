/**
 * The reachability plan, reaching an actual notice.
 *
 * `lib/fuel/planning.js` shipped with thirteen passing tests and NO PRODUCTION
 * CALLER. `planFuelStop` was reachable only from its own test file, so the
 * feature — "a truck cannot reach the stop it was given, and here is by how
 * much" — existed in the repository and not in the application. These tests are
 * about the wiring rather than the arithmetic, which `fuelPlanning.test.js`
 * already covers.
 *
 * THE RESTRAINT IS PART OF THE FEATURE. The plan names no alternative station,
 * because Wenze has no database of truck-accessible stops, prices or opening
 * hours. A test below asserts that no notice ever suggests one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const watcher = require('../services/fuelStop/riskWatch');
const { planFuelStop } = require('../lib/fuel/planning');

const NOW = Date.parse('2026-09-20T18:00:00Z');
const at = (mins) => new Date(NOW - mins * 60000).toISOString();

/**
 * One truck, one open fuel watch. The station sits 0.9 degrees of longitude
 * away — about 47 miles at this latitude — or further when `stationLng` moves.
 */
function harness({ location, alert = null, baseline = null } = {}) {
  const calls = { notified: [] };
  const deps = {
    groups: {
      async getDriverGroupsByActiveFilter() {
        return [{ id: 7, group_name: 'WENZE UNIT # 310 JOHN DOE' }];
      },
    },
    people: { async getOpenPeopleForUnits(units) { return new Map(units.map((u) => [u, 11])); } },
    readings: { async recordAndCompare() { return { previous: baseline }; } },
    fuel: { async listActiveFuelStopAlerts() { return alert ? [alert] : []; } },
    eldSettings: { async getEldConfig() { return { samsaraEnabled: true }; } },
    providers: {
      async fetchProviderFleets() { return { fleets: {}, errors: [] }; },
      resolveLocationForUnit() {
        return { location: location ? { ...location, lastUpdated: at(5) } : null };
      },
    },
    notifications: { async noticeSentWithin() { return false; } },
    async notify(n) { calls.notified.push(n); return { recorded: true, delivered: true }; },
  };
  return { deps, calls };
}

/** 300 miles east — far past the range of a tank at 20%. */
const FAR_STATION = {
  group_id: 7, station_lat: 41, station_lng: -81.5, station_name: 'Pilot 442',
  created_at: at(60), last_distance_miles: null,
};

const AT_20_PERCENT = { lat: 41, lng: -87, speedMph: 60, fuelPercent: 20 };

function noticeFor(calls, matcher) {
  return calls.notified.find((n) => matcher.test(n.title));
}

// ── the plan reaches the notice ──────────────────────────────────────────────

test('A TRUCK THAT CANNOT REACH ITS STOP IS TOLD BY HOW MUCH', async () => {
  const { deps, calls } = harness({ location: AT_20_PERCENT, alert: FAR_STATION });
  await watcher.runFuelRiskCheck({ now: NOW, deps });

  const notice = noticeFor(calls, /may not reach/);
  assert.ok(notice, 'the unreachable-stop risk was reported');
  const advice = notice.lines.find((l) => /will not get there/.test(l));
  assert.ok(advice, `the plan's advice is one of the lines — got ${JSON.stringify(notice.lines)}`);
  assert.match(advice, /miles in the tank/);
  assert.match(advice, /Pilot 442/, 'and it names the stop it cannot reach');
  assert.match(advice, /pick a closer stop/, 'leaving the choice to somebody who can see one');
});

test('IT CANNOT NAME AN ALTERNATIVE STATION, because it is given no way to learn one', () => {
  // STRUCTURAL, NOT TEXTUAL. Grepping a rendered line for station-shaped words
  // proves nothing — nothing in the fixture produces one, so the assertion
  // would pass against an implementation that invented stations freely. The
  // guarantee worth asserting is that there is no parameter through which a
  // catalogue of stations, prices or opening hours could arrive, and no import
  // that could fetch one. Same reasoning as `evaluateSuspension`, which is
  // asserted to have no parameter a model verdict could reach.
  // eslint-disable-next-line global-require
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib', 'fuel', 'planning.js'), 'utf8'
  );

  const signature = source.slice(
    source.indexOf('function planFuelStop('),
    source.indexOf('} = {}) {') + 5
  );
  for (const forbidden of ['stations', 'candidates', 'alternatives', 'nearby', 'prices']) {
    assert.ok(!signature.includes(forbidden),
      `planFuelStop takes no "${forbidden}" — it plans for the stop it was given`);
  }
  assert.ok(signature.includes('stationName'),
    'only the NAME of the assigned stop, which the caller already knew');

  assert.ok(!/require\(/.test(source),
    'and it imports nothing, so it cannot go and look a station up either');

  // The one station name it can utter is the one it was handed.
  const out = planFuelStop({ rangeMiles: 80, milesToStation: 200, stationName: 'Pilot 442' });
  assert.match(out.advice, /Pilot 442/);
  assert.match(out.advice, /pick a closer stop/,
    'the alternative is a person, named as such');
});

test('the urgency facts travel with it, and are the numbers the advice was written from',
  async () => {
    const { deps, calls } = harness({ location: AT_20_PERCENT, alert: FAR_STATION });
    await watcher.runFuelRiskCheck({ now: NOW, deps });

    const notice = noticeFor(calls, /may not reach/);
    assert.equal(typeof notice.facts.rangeMiles, 'number');
    assert.equal(typeof notice.facts.milesToStation, 'number');
    assert.ok(notice.facts.milesToStation > notice.facts.rangeMiles,
      'and they say the same thing the sentence does');
    assert.equal(notice.severity, 'serious',
      "this risk's own severity, not the fuel category's catalogued warning");
  });

// ── and stays out of the notices it is not about ─────────────────────────────

test('a risk the plan is not about carries no range sentence', async () => {
  // A stale instruction is about a date, not a distance. The plan would be a
  // sentence about range printed under a notice about neither.
  const { deps, calls } = harness({
    location: { lat: 41, lng: -87, speedMph: 60, fuelPercent: 90 },
    alert: { ...FAR_STATION, created_at: at(60 * 40) },
  });
  await watcher.runFuelRiskCheck({ now: NOW, deps });

  const stale = noticeFor(calls, /out of date/);
  assert.ok(stale, 'the stale-instruction risk was reported');
  for (const line of stale.lines) {
    assert.doesNotMatch(line, /miles of margin|reaches the stop|will not get there/);
  }
});

test('NO FUEL READING MEANS NO NUMBERS AT ALL — a missing tank is not an empty one', async () => {
  const { deps, calls } = harness({
    location: { lat: 41, lng: -87, speedMph: 60 },
    alert: { ...FAR_STATION, created_at: at(60 * 40) },
  });
  await watcher.runFuelRiskCheck({ now: NOW, deps });

  assert.ok(calls.notified.length > 0, 'the date-based risk still fires without fuel');
  for (const notice of calls.notified) {
    assert.deepEqual(notice.facts, {},
      'no invented range, and therefore nothing for the priority rules to escalate on');
  }
});

// ── a tank that is urgent on its own ────────────────────────────────────────

test('A CRITICAL TANK IS "NOW" EVEN WITH NO ASSIGNED STOP TO MEASURE AGAINST', async () => {
  // The bug this pins: the only fuel facts were `rangeMiles` and
  // `milesToStation`, so a truck at 6% with no fuel watch open produced NO
  // facts, landed at `whenever`, and could be held for an hour behind three
  // other notices about the same driver. A tank that low is urgent whether or
  // not anybody has named a stop.
  // eslint-disable-next-line global-require
  const { priorityFor, LEVELS } = require('../lib/notifications/priority');

  const { deps, calls } = harness({
    location: { lat: 41, lng: -87, speedMph: 60, fuelPercent: 6 },
    alert: null,
  });
  await watcher.runFuelRiskCheck({ now: NOW, deps });

  const notice = noticeFor(calls, /fuel at 6%/);
  assert.ok(notice, 'the critical-fuel risk was reported');
  assert.equal(notice.severity, 'serious');
  assert.equal(notice.facts.fuelPercent, 6,
    'the percentage travels even though there is no reachability plan');
  assert.equal(priorityFor({ severity: notice.severity, facts: notice.facts }).level,
    LEVELS.NOW, 'and a "now" is never held, however crowded the morning');
});

test('the threshold is the fuel module\'s, not a second copy of the number', () => {
  // eslint-disable-next-line global-require
  const { priorityFor, LEVELS } = require('../lib/notifications/priority');
  // eslint-disable-next-line global-require
  const { DEFAULTS } = require('../lib/fuel/risk');

  const at = (pct) => priorityFor({ severity: 'serious', facts: { fuelPercent: pct } }).level;
  assert.equal(at(DEFAULTS.criticalFuelPercent), LEVELS.NOW, 'exactly at the threshold is urgent');
  assert.equal(at(DEFAULTS.criticalFuelPercent + 1), LEVELS.WHENEVER,
    'and one point above it is not — the boundary is the fuel module\'s to move');
});

test('a low-but-not-critical tank with an unreachable stop is still urgent', async () => {
  // The two rules must compose: a `now` reached by one must not be lowered by
  // the other. Both branches now raise rather than assign.
  // eslint-disable-next-line global-require
  const { priorityFor, LEVELS } = require('../lib/notifications/priority');
  assert.equal(
    priorityFor({
      severity: 'serious',
      facts: { fuelPercent: 6, rangeMiles: 600, milesToStation: 560 },
    }).level,
    LEVELS.NOW,
    'a 40-mile margin says "today"; the tank still says "now"'
  );
});
