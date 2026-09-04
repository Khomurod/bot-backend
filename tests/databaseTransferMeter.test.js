/**
 * The monthly database-transfer meter.
 *
 * It exists because this deployment reached 4.222 GB of a 5 GB monthly
 * allowance with nothing in the application aware of it. So the behaviour worth
 * pinning is not arithmetic elegance — it is that the counters move, that a
 * restart does not lose the month, that a new month starts clean, that each
 * warning fires ONCE (a warning repeated every minute is noise nobody reads),
 * and that a failed flush does not erase what it was carrying.
 *
 * No database and no network: the meter itself does no I/O.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const meter = require('../database/transferMeter');
const { usageReport, levelFor, GB } = require('../database/transferUsage');

test.beforeEach(() => meter.reset());

const result = (rows) => ({ rows, rowCount: rows.length });
const row = (i) => ({ id: i, unit_number: `10${i}`, driver_name: 'A Driver', note: 'x'.repeat(50) });
const rows = (n) => Array.from({ length: n }, (_, i) => row(i));

test('a query moves the counters', () => {
  meter.recordQuery(result(rows(10)));
  const snapshot = meter.snapshot();
  assert.equal(snapshot.queries, 1);
  assert.equal(snapshot.rows, 10);
  assert.ok(snapshot.bytes > 0, 'ten rows must be counted as more than nothing');
});

test('a query returning nothing still costs the protocol overhead', () => {
  meter.recordQuery(result([]));
  assert.ok(meter.snapshot().bytes > 0);
  assert.equal(meter.snapshot().rows, 0);
});

test('bigger results are counted as bigger', () => {
  meter.recordQuery(result(rows(5)));
  const small = meter.snapshot().bytes;
  meter.reset();
  meter.recordQuery(result(rows(500)));
  const large = meter.snapshot().bytes;
  assert.ok(large > small * 10, `500 rows (${large}) must dwarf 5 rows (${small})`);
});

test('sampling calibrates the bytes-per-row estimate against real rows', () => {
  // Every SAMPLE_EVERY-th query is measured for real; the rest are estimated
  // from the moving average that measurement maintains.
  const wide = { id: 1, blob: 'y'.repeat(5000) };
  for (let i = 0; i < meter.SAMPLE_EVERY + 1; i += 1) {
    meter.recordQuery({ rows: [wide], rowCount: 1 });
  }
  assert.ok(
    meter.snapshot().bytesPerRow > 1000,
    `expected the average to learn from 5KB rows, got ${meter.snapshot().bytesPerRow}`,
  );
});

test('an unserializable row does not break accounting', () => {
  const circular = { id: 1 };
  circular.self = circular;
  for (let i = 0; i < meter.SAMPLE_EVERY + 1; i += 1) {
    meter.recordQuery({ rows: [circular], rowCount: 1 });
  }
  assert.equal(meter.snapshot().queries, meter.SAMPLE_EVERY + 1);
  assert.ok(meter.snapshot().bytes > 0);
});

test('pending counters are handed over once, then cleared', () => {
  meter.recordQuery(result(rows(3)));
  const first = meter.consumePending();
  assert.ok(first.bytes > 0);
  assert.equal(first.queries, 1);
  const second = meter.consumePending();
  assert.equal(second.bytes, 0, 'nothing may be counted into the table twice');
  assert.equal(second.queries, 0);
  // The month total is unaffected by flushing.
  assert.ok(meter.snapshot().bytes > 0);
});

test('a failed flush puts its counters back', () => {
  meter.recordQuery(result(rows(3)));
  const pending = meter.consumePending();
  meter.recordPending(pending);
  const again = meter.consumePending();
  assert.equal(again.bytes, pending.bytes, 'a write that never landed must be retried');
  assert.equal(again.queries, pending.queries);
});

test('a restart adopts the stored total instead of reporting zero', () => {
  meter.recordQuery(result(rows(1)));
  const adopted = meter.adoptPersisted({
    monthKey: meter.currentMonthKey(), bytes: 4_000_000_000, queries: 900, rows: 5000,
  });
  assert.equal(adopted, true);
  assert.equal(meter.snapshot().bytes, 4_000_000_000);
  // Another month's row is not this month's business.
  assert.equal(meter.adoptPersisted({ monthKey: '1999-01', bytes: 1 }), false);
  assert.equal(meter.snapshot().bytes, 4_000_000_000);
});

test('a new month starts a new budget', () => {
  meter.recordQuery(result(rows(100)));
  assert.ok(meter.snapshot().bytes > 0);
  const janKey = meter.currentMonthKey(new Date('2026-01-15T00:00:00Z'));
  const febKey = meter.currentMonthKey(new Date('2026-02-01T00:00:00Z'));
  assert.equal(janKey, '2026-01');
  assert.equal(febKey, '2026-02');
  assert.equal(meter.rollMonthIfNeeded(new Date('2035-07-04T00:00:00Z')), true);
  assert.equal(meter.snapshot().bytes, 0, 'a fresh month counts from zero');
  assert.equal(meter.snapshot().monthKey, '2035-07');
});

test('each warning threshold fires exactly once per month', () => {
  assert.deepEqual(meter.newlyCrossedThresholds(0.5), []);
  assert.deepEqual(meter.newlyCrossedThresholds(0.81), [0.8]);
  assert.deepEqual(meter.newlyCrossedThresholds(0.85), [], 'no repeat while still at 85%');
  assert.deepEqual(meter.newlyCrossedThresholds(0.91), [0.9]);
  assert.deepEqual(meter.newlyCrossedThresholds(0.99), [0.95]);
  assert.deepEqual(meter.newlyCrossedThresholds(1.5), [], 'over budget does not re-warn');
  // A new month re-arms them.
  meter.rollMonthIfNeeded(new Date('2035-08-04T00:00:00Z'));
  assert.deepEqual(meter.newlyCrossedThresholds(0.99), [0.8, 0.9, 0.95]);
});

test('a jump straight past every threshold reports all of them once', () => {
  assert.deepEqual(meter.newlyCrossedThresholds(0.97), [0.8, 0.9, 0.95]);
  assert.deepEqual(meter.newlyCrossedThresholds(0.99), []);
});

// ─── the report the panel and the log read ───────────────────────────────────

test('the report names the level and says it is an estimate', () => {
  meter.adoptPersisted({ monthKey: meter.currentMonthKey(), bytes: 4.5 * GB, queries: 10, rows: 20 });
  const report = usageReport({ budgetBytes: 5 * GB });
  assert.equal(report.estimated, true, 'a percentage must never pass as the provider\'s figure');
  assert.equal(report.level, 'high');
  assert.equal(report.percent, 90);
  assert.equal(report.budgetGigabytes, 5);
  assert.equal(report.gigabytes, 4.5);
  assert.equal(report.monthKey, meter.currentMonthKey());
});

test('levels line up with the 80/90/95 warnings', () => {
  assert.equal(levelFor(0), 'ok');
  assert.equal(levelFor(0.79), 'ok');
  assert.equal(levelFor(0.8), 'warning');
  assert.equal(levelFor(0.9), 'high');
  assert.equal(levelFor(0.95), 'critical');
  assert.equal(levelFor(2), 'critical');
});

test('a missing budget falls back to 5 GB rather than dividing by zero', () => {
  meter.adoptPersisted({ monthKey: meter.currentMonthKey(), bytes: 5 * GB });
  const report = usageReport({ budgetBytes: 0 });
  assert.equal(report.budgetGigabytes, 5);
  assert.equal(report.percent, 100);
  assert.equal(Number.isFinite(report.percent), true);
});

// ─── the estimator must never expand what it measures ────────────────────────

test('a bytea column is counted by its length, not expanded into JSON', () => {
  // JSON.stringify turns a Buffer into one array element PER BYTE. Sampling a
  // trailer-media row that way would allocate hundreds of megabytes on a
  // 512 MB instance — a usage meter must not be able to kill the app.
  const { estimateValueBytes } = meter;
  const blob = Buffer.alloc(2 * 1024 * 1024, 7);
  const bytes = estimateValueBytes({ id: 1, file: blob });
  assert.ok(bytes >= blob.length, 'the blob must be counted');
  assert.ok(bytes < blob.length * 1.01, `expected ~${blob.length}, got ${bytes}`);
});

test('a circular row terminates instead of looping', () => {
  const circular = { id: 1 };
  circular.self = circular;
  const bytes = meter.estimateValueBytes(circular);
  assert.ok(Number.isFinite(bytes) && bytes > 0);
});

test('nested JSONB is measured, not ignored', () => {
  const shallow = meter.estimateValueBytes({ a: 'x' });
  const deep = meter.estimateValueBytes({ a: 'x', payload: { items: ['aaaaaaaaaa', 'bbbbbbbbbb'] } });
  assert.ok(deep > shallow);
});
