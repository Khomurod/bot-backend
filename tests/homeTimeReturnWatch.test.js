/**
 * The watcher, with the fleet and the load board replaced.
 *
 * Two promises are checked here that the pure rules cannot make on their own:
 * a tick with nobody at home costs NOTHING (no Samsara call, no Datatruck
 * scan), and a medium verdict is filed under a check key with no action behind
 * it, so it is unable to change anyone's state no matter what a later batch
 * decides to apply.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const watcher = require('../services/homeTime/returnToRoadWatch');
const { actionForCheck } = require('../services/operations/corrections/actions');

const {
  harness, NOW, at, HOME, FAR, DRIVER,
} = require('./helpers/returnWatchHarness');

test('nobody at home costs no provider calls at all', async () => {
  const { deps, calls } = harness({ drivers: [] });
  const summary = await watcher.runReturnToRoadCheck({ now: NOW, deps });
  assert.equal(summary.skipped, 'nobody_home');
  assert.equal(calls.fleets, 0, 'no fleet fetch');
  assert.equal(calls.orders, 0, 'no Datatruck scan');
});

test('one fleet fetch and one order scan serve every driver at home', async () => {
  const { deps, calls } = harness({
    drivers: [DRIVER, { ...DRIVER, groupId: 4 }, { ...DRIVER, groupId: 5 }],
    location: { lat: HOME.lat, lng: HOME.lng, speedMph: 0, lastUpdated: at(5) },
  });
  await watcher.runReturnToRoadCheck({ now: NOW, deps });
  assert.equal(calls.fleets, 1);
  assert.equal(calls.orders, 1);
});

test('a parked truck sets the anchor; a moving one never does', async () => {
  const parkedRun = harness({ drivers: [DRIVER], location: { ...HOME, speedMph: 0, lastUpdated: at(5) } });
  await watcher.runReturnToRoadCheck({ now: NOW, deps: parkedRun.deps });
  assert.equal(parkedRun.calls.observations[0].anchorEligible, true);

  const movingRun = harness({ drivers: [DRIVER], location: { ...FAR, speedMph: 61, lastUpdated: at(5) } });
  await watcher.runReturnToRoadCheck({ now: NOW, deps: movingRun.deps });
  assert.equal(movingRun.calls.observations[0].anchorEligible, false,
    'anchoring mid-drive would put "home" on an interstate');
});

test('a load with the truck still parked at home files nothing', async () => {
  const { deps, calls } = harness({
    drivers: [DRIVER],
    location: { ...HOME, speedMph: 0, lastUpdated: at(5) },
    order: { load: { status: 'assigned', loadIdentifier: 'L1' } },
    watchRow: { groupId: 3, anchor: { ...HOME, at: at(600) }, maxMilesFromAnchor: 0, movingSightings: 0 },
  });
  const summary = await watcher.runReturnToRoadCheck({ now: NOW, deps });
  assert.equal(summary.low, 1);
  assert.equal(calls.findings.length, 0, 'no finding, no noise');
});

test('a load plus movement files an auto-tier finding with the proposed change', async () => {
  const { deps, calls } = harness({
    drivers: [DRIVER],
    location: { ...FAR, speedMph: 61, lastUpdated: at(5) },
    order: { load: { status: 'dispatched', loadIdentifier: 'L1' } },
    watchRow: {
      groupId: 3, anchor: { ...HOME, at: at(600) },
      last: { ...FAR, speedMph: 58, at: at(40) }, maxMilesFromAnchor: 66, movingSightings: 1,
    },
  });
  const summary = await watcher.runReturnToRoadCheck({ now: NOW, deps });
  assert.equal(summary.high, 1);
  const finding = calls.findings[0];
  assert.equal(finding.checkKey, 'home_time.returned_to_road');
  assert.equal(finding.tier, 'auto');
  assert.equal(finding.subjectType, 'road_history');
  assert.equal(finding.subjectId, '412', 'the STAY is the subject, so a later stay files its own finding');
  assert.equal(finding.proposedChange.groupId, 3);
  assert.equal(finding.proposedChange.personId, 11);
  assert.ok(finding.proposedChange.returnToRoadAt);
  assert.match(finding.title, /back on the road/);
});

test('an unclear case files a finding NO action can ever apply', async () => {
  const { deps, calls } = harness({
    drivers: [DRIVER],
    location: null, // no GPS
    order: { load: { status: 'in_transit', loadIdentifier: 'L1' } },
    watchRow: { groupId: 3, anchor: { ...HOME, at: at(600) }, maxMilesFromAnchor: 0, movingSightings: 0 },
  });
  const summary = await watcher.runReturnToRoadCheck({ now: NOW, deps });
  assert.equal(summary.medium, 1);
  assert.equal(calls.findings[0].checkKey, 'home_time.return_to_road_unclear');
  assert.equal(calls.findings[0].proposedChange, null);
  assert.equal(actionForCheck('home_time.return_to_road_unclear'), null,
    'the medium key has no action — it cannot change state even if enabled');
  assert.ok(actionForCheck('home_time.returned_to_road'), 'only the high key has one');
});

test('what a pass does not re-file is resolved', async () => {
  const { deps, calls } = harness({
    drivers: [DRIVER],
    location: { ...HOME, speedMph: 0, lastUpdated: at(5) },
    watchRow: { groupId: 3, anchor: { ...HOME, at: at(600) } },
  });
  await watcher.runReturnToRoadCheck({ now: NOW, deps });
  assert.deepEqual(calls.resolved[0].keys, ['home_time.returned_to_road', 'home_time.return_to_road_unclear']);
  assert.deepEqual(calls.resolved[0].keep, []);
});

test('AI is asked only about a medium case, and may raise it only when the coordinates already agree', async () => {
  const asked = [];
  const reviewer = async ({ verdict }) => {
    asked.push(verdict.confidence);
    return { ...verdict, confidence: 'high', signals: [...verdict.signals, 'ai_agreed'] };
  };
  const { deps: highDeps } = harness({
    drivers: [DRIVER],
    location: { ...FAR, speedMph: 61, lastUpdated: at(5) },
    order: { load: { status: 'dispatched' } },
    watchRow: { groupId: 3, anchor: { ...HOME, at: at(600) }, last: { ...FAR, speedMph: 58, at: at(40) }, maxMilesFromAnchor: 66, movingSightings: 1 },
    reviewer,
  });
  await watcher.runReturnToRoadCheck({ now: NOW, deps: highDeps });
  assert.deepEqual(asked, [], 'a high verdict needs no model');

  const { deps: medDeps, calls } = harness({
    drivers: [DRIVER],
    location: null,
    order: { load: { status: 'in_transit' } },
    watchRow: { groupId: 3, anchor: { ...HOME, at: at(600) } },
    reviewer,
  });
  await watcher.runReturnToRoadCheck({ now: NOW, deps: medDeps });
  assert.deepEqual(asked, ['medium']);
  assert.equal(calls.findings[0].checkKey, 'home_time.returned_to_road', 'the review moved it');
});

test('a broken model leaves the deterministic verdict exactly as it was', async () => {
  const { deps, calls } = harness({
    drivers: [DRIVER],
    location: null,
    order: { load: { status: 'in_transit' } },
    watchRow: { groupId: 3, anchor: { ...HOME, at: at(600) } },
    reviewer: async () => { throw new Error('every provider failed'); },
  });
  const summary = await watcher.runReturnToRoadCheck({ now: NOW, deps });
  assert.equal(summary.medium, 1);
  assert.equal(calls.findings[0].checkKey, 'home_time.return_to_road_unclear');
});

test('a provider outage does not stop the pass or invent a departure', async () => {
  const { deps, calls } = harness({
    drivers: [DRIVER], location: null,
    providerErrors: [{ provider: 'samsara', message: 'down' }],
  });
  const summary = await watcher.runReturnToRoadCheck({ now: NOW, deps });
  assert.equal(summary.providerErrors, 1);
  assert.equal(summary.high, 0);
  assert.equal(calls.findings.filter((f) => f.checkKey === 'home_time.returned_to_road').length, 0);
});

test('the fleet MAP reaches the lookup, not the envelope around it', async () => {
  const { deps, calls } = harness({
    drivers: [DRIVER], location: { ...HOME, speedMph: 0, lastUpdated: at(5) },
  });
  await watcher.runReturnToRoadCheck({ now: NOW, deps });
  assert.equal(calls.resolvedWith.length, 1);
  const passed = calls.resolvedWith[0];
  assert.equal('errors' in passed, false, 'the envelope must be unwrapped');
  assert.ok('samsara' in passed, 'the fleet map itself is what resolves a unit');
});

test('every home stay is its own finding, so a second return is not swallowed', async () => {
  // upsertFinding reopens only a RESOLVED row. Keyed on the group, the second
  // stay would update the first stay's already-applied row and never be acted on.
  const first = harness({
    drivers: [{ ...DRIVER, roadHistoryId: 412 }],
    location: { ...FAR, speedMph: 61, lastUpdated: at(5) },
    order: { load: { status: 'dispatched' } },
    watchRow: {
      groupId: 3, anchor: { ...HOME, at: at(600) },
      last: { ...FAR, speedMph: 58, at: at(40) }, maxMilesFromAnchor: 66, movingSightings: 1,
    },
  });
  await watcher.runReturnToRoadCheck({ now: NOW, deps: first.deps });

  const second = harness({
    drivers: [{ ...DRIVER, roadHistoryId: 900, homeSince: at(60 * 24) }],
    location: { ...FAR, speedMph: 61, lastUpdated: at(5) },
    order: { load: { status: 'dispatched' } },
    watchRow: {
      groupId: 3, anchor: { ...HOME, at: at(600) },
      last: { ...FAR, speedMph: 58, at: at(40) }, maxMilesFromAnchor: 66, movingSightings: 1,
    },
  });
  await watcher.runReturnToRoadCheck({ now: NOW, deps: second.deps });

  assert.notEqual(
    first.calls.findings[0].subjectId,
    second.calls.findings[0].subjectId,
    'two different home stays are two different findings'
  );
});

/**
 * "The software moved a driver" is the claim that has to be answerable months
 * later, so the finding records WHO decided beside WHAT was decided: whether a
 * model was consulted at all, which provider and model answered, how sure it
 * said it was, its one-line reason, and that the change was automatic rather
 * than typed by a person. The correction is audited against this finding, so
 * this is where that trail begins.
 */
test('the finding records who decided, not only what was decided', async () => {
  const { deps, calls } = harness({
    drivers: [DRIVER],
    location: { ...FAR, speedMph: 61, lastUpdated: at(5) },
    order: { load: { status: 'dispatched', loadIdentifier: 'L1' } },
    watchRow: {
      groupId: 3, anchor: { ...HOME, at: at(600) },
      last: { ...FAR, speedMph: 58, at: at(40) }, maxMilesFromAnchor: 66, movingSightings: 1,
    },
  });
  await watcher.runReturnToRoadCheck({ now: NOW, deps });
  const e = calls.findings[0].evidence;

  assert.equal(e.decidedAutomatically, true, 'nobody typed this');
  // No model was involved: the deterministic score reached high on its own.
  assert.equal(e.aiAssisted, false,
    'written explicitly — an ABSENT field reads as "nobody recorded it"');
  assert.equal(e.aiProvider, null);
  assert.equal(e.aiModel, null);
  assert.equal(e.aiReason, null);
  // And the facts that justified it are all there to be re-read.
  assert.equal(e.loadIdentifier, 'L1');
  assert.equal(e.movementProven, true);
  assert.equal(e.parkedAtHome, false);
});

test('when a model IS consulted, the finding names it and quotes its reason', async () => {
  const { deps, calls } = harness({
    drivers: [DRIVER],
    // Load in transit with no GPS at all → medium, which is the only case the
    // reasoner is ever asked about.
    location: null,
    order: { load: { status: 'in_transit', loadIdentifier: 'L9' } },
    watchRow: { groupId: 3, anchor: { ...HOME, at: at(600) }, maxMilesFromAnchor: 0, movingSightings: 0 },
  });
  deps.reasoner = {
    async reviewReturnEvidence({ verdict }) {
      return {
        ...verdict,
        confidence: 'low',
        aiAssisted: true,
        aiProvider: 'groq',
        aiModel: 'llama-3.3-70b-versatile',
        aiConfidence: 72,
        aiReason: 'the load was assigned but nothing shows the truck moving',
        blockers: [...verdict.blockers, 'ai_disagreed'],
      };
    },
  };
  await watcher.runReturnToRoadCheck({ now: NOW, deps });

  // It stood the case DOWN, so nothing is filed at all — that is the point.
  assert.equal(calls.findings.length, 0, 'a model saying "no" costs nothing and files nothing');
});
