/**
 * The run ledger against a real PostgreSQL.
 *
 * What is proved here is arithmetic that lives entirely in one UPSERT, which is
 * the kind of thing a fake cannot check and a production incident eventually
 * does: does a failure increment the streak, does anything that is NOT a
 * failure clear it, and does `blocked` — a feature nobody has configured —
 * stay out of the failure counters, since counting it would put every
 * unconfigured feature permanently in the "needs a person" list and make that
 * list worthless.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { classifyRun, RUN_STATES } = require('../lib/operations/runHealth');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { backgroundRuns } = h.loadDataLayer(['backgroundRuns']);
  return { h, runs: backgroundRuns };
}

test('a first pass creates the row and counts once', { skip: skipWithoutPg() }, async (t) => {
  const { runs } = await setup(t);
  await runs.recordRunStart('fuel_risk', { expectedIntervalSeconds: 1200 });
  await runs.recordRunFinish('fuel_risk', { status: 'ok', summary: { checked: 110, reported: 2 } });

  const row = await runs.getRun('fuel_risk');
  assert.equal(row.runsTotal, 1);
  assert.equal(row.failuresTotal, 0);
  assert.equal(row.consecutiveFailures, 0);
  assert.equal(row.lastStatus, 'ok');
  assert.equal(row.expectedIntervalSeconds, 1200);
  assert.deepEqual(row.lastSummary, { checked: 110, reported: 2 });
  assert.ok(row.lastOkAt);
});

test('failures accumulate and any non-failure clears the streak', { skip: skipWithoutPg() }, async (t) => {
  const { runs } = await setup(t);
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await runs.recordRunFinish('load_lifecycle', { status: 'error', error: 'boom' });
  }
  let row = await runs.getRun('load_lifecycle');
  assert.equal(row.consecutiveFailures, 4);
  assert.equal(row.failuresTotal, 4);
  assert.equal(row.lastOkAt, null, 'it has never succeeded');
  assert.ok(row.lastErrorAt);
  assert.equal(classifyRun(row, { expectedIntervalSeconds: 600 }).state, RUN_STATES.FAILING);

  await runs.recordRunFinish('load_lifecycle', { status: 'ok', summary: { checked: 3 } });
  row = await runs.getRun('load_lifecycle');
  assert.equal(row.consecutiveFailures, 0, 'the streak is what "is it failing NOW" reads');
  assert.equal(row.failuresTotal, 4, 'the lifetime count is what "has it ever" reads');
  assert.ok(row.lastErrorAt, 'and when it last failed survives the recovery, or "working again" '
    + 'could not be told from "has been fine for months"');
  assert.equal(classifyRun(row, { expectedIntervalSeconds: 600 }).state, RUN_STATES.RECOVERED);
});

test('blocked is configuration, not failure, and never enters the failure counters',
  { skip: skipWithoutPg() }, async (t) => {
    const { runs } = await setup(t);
    await runs.recordRunFinish('route_control', {
      status: 'blocked', error: 'no Google Maps key configured',
    });
    const row = await runs.getRun('route_control');
    assert.equal(row.consecutiveFailures, 0);
    assert.equal(row.failuresTotal, 0);
    assert.equal(classifyRun(row, { expectedIntervalSeconds: 1800 }).state,
      RUN_STATES.NEEDS_ATTENTION);
    assert.equal(classifyRun(row, { expectedIntervalSeconds: 1800 }).reason,
      'no Google Maps key configured');
  });

test('the schema refuses a status it does not know', { skip: skipWithoutPg() }, async (t) => {
  const { h } = await setup(t);
  await assert.rejects(
    () => h.query(
      "INSERT INTO background_service_runs (service_key, last_status) VALUES ('x', 'probably_fine')"
    ),
    /background_service_runs_status_check|violates check constraint/
  );
});

test('a summary is counts and short strings — never a payload', { skip: skipWithoutPg() }, async (t) => {
  const { runs } = await setup(t);
  await runs.recordRunFinish('safety_coach', {
    status: 'ok',
    summary: {
      checked: 9,
      coached: 2,
      // Every one of these is the kind of thing that must not reach a PUBLIC
      // health endpoint through a field twenty different workers write.
      drivers: ['SAM RIVERA', 'ALEX KIM'],
      message: 'x'.repeat(900),
      nested: { apiKey: 'secret-value-here' },
    },
  });
  const row = await runs.getRun('safety_coach');
  assert.deepEqual(Object.keys(row.lastSummary).sort(), ['checked', 'coached', 'drivers', 'message']);
  assert.equal(row.lastSummary.drivers, 2, 'an array becomes its length; the names do not travel');
  assert.equal(row.lastSummary.message.length, 200, 'and a long string is cut');
  assert.equal(row.lastSummary.nested, undefined, 'a nested object is dropped whole');
});

test('every recorded worker can be read back at once', { skip: skipWithoutPg() }, async (t) => {
  const { runs } = await setup(t);
  await runs.recordRunFinish('scheduler', { status: 'ok' });
  await runs.recordRunFinish('retention_watch', { status: 'skipped' });
  const map = await runs.getRunMap();
  assert.equal(map.size, 2);
  assert.equal(map.get('retention_watch').lastStatus, 'skipped');
});
