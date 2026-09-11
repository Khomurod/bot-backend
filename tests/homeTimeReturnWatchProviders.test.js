/**
 * A telemetry provider having a bad afternoon, and what the pass says about it.
 *
 * THE DISTINCTION EVERY TEST HERE DEFENDS: a pass that ran and could not see
 * is not a pass that failed, and neither is a pass that saw something. Getting
 * that wrong in either direction is expensive — one way a real outage is
 * reported as thirty consecutive failures nobody can act on, the other way an
 * outage is reported as a clean run.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  harness, NOW, at, HOME, FAR, DRIVER, watcher,
} = require('./helpers/returnWatchHarness');

/**
 * PRODUCTION FOUND THIS ONE. `fetchProviderFleets` was the only call in the
 * pass without a `.catch` — `getActiveOrders` beside it always had one, and the
 * asymmetry was an oversight. A 429 from a telemetry provider killed the whole
 * pass, every pass: nineteen consecutive failures, invisible until the run
 * ledger recorded them and the error classifier named the cause.
 *
 * It reproduced clean locally only because there is no API key locally, and so
 * no quota to exceed.
 */
test('A RATE-LIMITED PROVIDER DEGRADES THE PASS INSTEAD OF KILLING IT', async () => {
  const { deps, calls } = harness({ drivers: [DRIVER], location: { ...HOME, speedMph: 0, lastUpdated: at(5) } });
  deps.providers.fetchProviderFleets = async () => {
    throw new Error('429 Too Many Requests');
  };
  const summary = await watcher.runReturnToRoadCheck({ deps, now: NOW });
  assert.equal(summary.watched, 1);
  assert.equal(summary.checked, 1,
    'the driver is still assessed — a return can be evidenced by ORDERS, which '
    + 'arrive on a different call');
  assert.equal(summary.providerErrors, 1, 'and the provider failure is counted');
  assert.ok(calls.orders >= 1, 'the orders call still happened');
});

test('BUT SEEING NOTHING AT ALL IS NOT REPORTED AS SUCCESS', async () => {
  const { deps } = harness({ drivers: [DRIVER], order: null });
  deps.providers.fetchProviderFleets = async () => { throw new Error('429 Too Many Requests'); };
  deps.orders.getActiveOrders = async () => ({ orders: [], error: null });
  const summary = await watcher.runReturnToRoadCheck({ deps, now: NOW });
  assert.match(summary.blocked || '', /no telemetry could be read/,
    'catching the failure must not turn a pass that can see nothing into a pass '
    + 'that reports success — that is the exact trade this work refuses');
  assert.equal(summary.error, undefined,
    'and it is BLOCKED rather than failed: the pass ran correctly and nobody answered');
});

test('SEEING NOTHING IS BLOCKED, NOT A FAILURE — the pass ran and nobody answered', async () => {
  // This reached THIRTY "consecutive failures" in production on a pass that was
  // completing every run and checking every driver. `runHealth` maps `blocked`
  // to needs_human_attention with a reason that NAMES the missing thing, which
  // is the difference between a sentence somebody acts on and a counter.
  // eslint-disable-next-line global-require
  const { statusFromSummary } = require('../services/operations/runLedger');
  const { deps } = harness({ drivers: [DRIVER], order: null });
  deps.providers.fetchProviderFleets = async () => ({
    fleets: { samsara: null, factor: null, leader: null },
    errors: [
      { provider: 'samsara', code: 'ETIMEDOUT', message: 'https://api.example/x?key=SECRET' },
      { provider: 'factor', code: 'ERROR', message: 'nope' },
    ],
  });
  deps.orders.getActiveOrders = async () => ({ orders: [], error: null });

  const summary = await watcher.runReturnToRoadCheck({ deps, now: NOW });

  assert.equal(statusFromSummary(summary).status, 'blocked');
  assert.match(summary.blocked, /samsara \(ETIMEDOUT\)/, 'it names who did not answer');
  assert.match(summary.blocked, /factor/);
  assert.doesNotMatch(summary.blocked, /SECRET|https?:/,
    'names and codes only — /api/health is public and a provider message can quote a URL');
});

test('ALL THREE PROVIDERS FAILING IS SEEING NOTHING, which the key count could not tell', async () => {
  // `fetchProviderFleets` always returns `{samsara, factor, leader}` with the
  // failed ones null, so `Object.keys(fleets).length` is three whatever
  // happened. The guard could only ever fire when the WHOLE call threw, and was
  // blind to exactly the case it exists for.
  const { deps } = harness({ drivers: [DRIVER], order: null });
  deps.providers.fetchProviderFleets = async () => ({
    fleets: { samsara: null, factor: null, leader: null },
    errors: [{ provider: 'samsara', code: 'ERROR', message: 'x' }],
  });
  deps.orders.getActiveOrders = async () => ({ orders: [], error: null });

  const summary = await watcher.runReturnToRoadCheck({ deps, now: NOW });
  assert.ok(summary.blocked, 'three null fleets is nothing seen, not three fleets seen');
});

test('an EMPTY fleet that really answered is not "nothing seen"', async () => {
  // A provider that answers with no vehicles has told us something: there are
  // none. That is a clean run, not a blocked one.
  const { deps } = harness({ drivers: [DRIVER], order: null });
  deps.providers.fetchProviderFleets = async () => ({
    fleets: { samsara: [], factor: null, leader: null }, errors: [],
  });
  deps.orders.getActiveOrders = async () => ({ orders: [], error: null });

  const summary = await watcher.runReturnToRoadCheck({ deps, now: NOW });
  assert.equal(summary.blocked, undefined, 'no provider errors, so nothing is blocked');
  assert.equal(summary.error, undefined);
});

test('a provider failure with orders still available is NOT an error', async () => {
  const { deps } = harness({
    drivers: [DRIVER],
    location: { ...HOME, speedMph: 0, lastUpdated: at(5) },
    // The half that still arrived. A return can be evidenced by a dispatched
    // load as well as by GPS, which is what makes degrading worth doing rather
    // than merely surviving.
    order: { load: { status: 'dispatched', loadIdentifier: 'L1' } },
  });
  deps.providers.fetchProviderFleets = async () => { throw new Error('429 Too Many Requests'); };
  const summary = await watcher.runReturnToRoadCheck({ deps, now: NOW });
  assert.equal(summary.error, undefined,
    'it saw something and did its job on what it had');
});

test('a provider error with no name never steals another provider\'s code', () => {
  // The names were mapped and then indexed back into the error array by
  // position, so one entry without a `provider` shifted every code onto the
  // wrong name. A misattributed cause is worse than none.
  const { deps } = harness({ drivers: [DRIVER], order: null });
  deps.providers.fetchProviderFleets = async () => ({
    fleets: { samsara: null, factor: null, leader: null },
    errors: [
      { code: 'ETIMEDOUT', message: 'no provider field' },
      { provider: 'factor', code: 'E403' },
    ],
  });
  deps.orders.getActiveOrders = async () => ({ orders: [], error: null });

  return watcher.runReturnToRoadCheck({ deps, now: NOW }).then((summary) => {
    assert.match(summary.blocked, /factor \(E403\)/);
    assert.doesNotMatch(summary.blocked, /factor \(ETIMEDOUT\)/,
      "factor did not time out — the nameless entry did");
  });
});

test('ONE PROVIDER\'S VEHICLES MUST NOT HIDE ANOTHER\'S OUTAGE', async () => {
  // The guard counted vehicles anywhere in the combined fleets. So Samsara
  // returning a hundred trucks belonging to other people made the pass read
  // healthy while Factor — which carries the watched drivers — was down and not
  // one of them could be assessed. The question is about the drivers this pass
  // is watching, not about the fleets.
  const { deps } = harness({ drivers: [DRIVER], order: null });
  deps.providers.fetchProviderFleets = async () => ({
    fleets: { samsara: [{ id: 'someone-else' }, { id: 'another' }], factor: null, leader: null },
    errors: [{ provider: 'factor', code: 'ETIMEDOUT' }],
  });
  // Nothing resolves for the watched driver.
  deps.providers.resolveLocationForUnit = () => ({ location: null });
  deps.orders.getActiveOrders = async () => ({ orders: [], error: null });

  const summary = await watcher.runReturnToRoadCheck({ deps, now: NOW });

  assert.equal(summary.driversSeen, 0);
  assert.ok(summary.blocked, 'two vehicles belonging to other drivers is not evidence about this one');
  assert.match(summary.blocked, /factor \(ETIMEDOUT\)/);
  assert.match(summary.blocked, /1 driver\(s\) at home/);
});

test('one watched driver resolving IS evidence the pass could run', async () => {
  const { deps } = harness({
    drivers: [DRIVER],
    location: { ...HOME, speedMph: 0, lastUpdated: at(5) },
    order: null,
  });
  deps.providers.fetchProviderFleets = async () => ({
    fleets: { samsara: [{ id: 'x' }], factor: null, leader: null },
    errors: [{ provider: 'factor', code: 'ETIMEDOUT' }],
  });
  deps.orders.getActiveOrders = async () => ({ orders: [], error: null });

  const summary = await watcher.runReturnToRoadCheck({ deps, now: NOW });
  assert.equal(summary.driversSeen, 1);
  assert.equal(summary.blocked, undefined,
    'a degraded pass that still answered about its drivers is not blocked');
});

// ── one driver's failure is one driver's failure ─────────────────────────────
//
// Production ran this watch at sixty consecutive failures on a critical worker
// while the pass itself completed every twelve minutes. The loop over the
// drivers at home sat bare inside the pass's single try, so whatever was thrown
// for one of them abandoned the rest, skipped the resolve, and painted the
// whole pass red — and the published reason could only say `other`.

test('a driver that throws does not abandon the drivers after it', async () => {
  const second = { ...DRIVER, groupId: 4, roadHistoryId: 413 };
  const third = { ...DRIVER, groupId: 5, roadHistoryId: 414 };
  const { deps, calls } = harness({
    drivers: [DRIVER, second, third],
    failObservationFor: DRIVER.groupId,
    location: { lat: FAR.lat, lng: FAR.lng, speedMph: 61, lastUpdated: at(5) },
    order: { load: { loadIdentifier: 'L1', status: 'dispatched', pickupTime: at(120) } },
  });

  const summary = await watcher.runReturnToRoadCheck({ now: NOW, deps });

  assert.equal(summary.driverErrors, 1);
  assert.equal(summary.checked, 2, 'the two healthy drivers were still checked');
  assert.equal(summary.error, undefined, 'a partial pass is not a failed pass');
  assert.equal(calls.resolved.length, 1, 'cleared findings are still resolved');
});

test('the failing driver’s kind is recorded, and never its message', async () => {
  const { deps } = harness({
    drivers: [DRIVER],
    failObservationFor: DRIVER.groupId,
  });

  const summary = await watcher.runReturnToRoadCheck({ now: NOW, deps });

  assert.equal(summary.errorKind, 'bad_value');
  // Every driver failed, so there is nothing partial left to report.
  assert.match(summary.error, /every one of the 1 driver\(s\)/);
  assert.match(summary.error, /refused as invalid/);
  // The message quotes the value the database rejected; the summary must not.
  assert.ok(!summary.error.includes('NaN'), summary.error);
});

test('a pass where only some drivers failed stays healthy in the ledger', async () => {
  const second = { ...DRIVER, groupId: 4, roadHistoryId: 413 };
  const { deps } = harness({ drivers: [DRIVER, second], failObservationFor: 4 });

  const summary = await watcher.runReturnToRoadCheck({ now: NOW, deps });

  const { statusFromSummary } = require('../services/operations/runLedger');
  assert.equal(statusFromSummary(summary).status, 'ok');
  assert.equal(summary.driverErrors, 1);
});

test('a code fault does not hide behind a provider outage', async () => {
  // Every driver throwing makes `driversSeen` zero, which is also the shape of
  // "no telemetry answered". `blocked` is read before `error`, so without the
  // guard a real exception would be reported as a configuration problem.
  const { deps } = harness({
    drivers: [DRIVER],
    failObservationFor: DRIVER.groupId,
    providerErrors: [{ provider: 'samsara', code: 429 }],
  });

  const summary = await watcher.runReturnToRoadCheck({ now: NOW, deps });

  assert.equal(summary.blocked, undefined, 'the exception is the story, not the 429');
  assert.match(summary.error, /every one of the 1 driver\(s\)/);
});
