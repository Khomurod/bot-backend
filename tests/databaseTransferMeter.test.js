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
  // media-bearing row that way would allocate hundreds of megabytes on a
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

// ── what is spending it ─────────────────────────────────────────────────────

/**
 * A PERCENTAGE TELLS SOMEBODY TO WORRY; A TABLE NAME TELLS THEM WHERE TO LOOK.
 *
 * The meter answered "78% of the allowance" and stopped there, which is the
 * right alarm and the wrong amount of information — there is nothing in it to
 * act on. The breakdown is the half that makes it actionable.
 */
test('bytes are attributed to the table the query named', () => {
  meter.recordQuery(result(rows(10)), 'SELECT * FROM group_messages WHERE id = $1');
  meter.recordQuery(result(rows(1)), 'SELECT * FROM groups');
  meter.recordQuery(result(rows(5)), 'select a from public.group_messages m');

  const out = meter.usageByLabel();
  assert.equal(out.tables[0].label, 'group_messages', 'the biggest reader comes first');
  assert.equal(out.tables[0].queries, 2, 'and a schema qualifier is not a second table');
  assert.equal(out.tables[0].rows, 15);
  assert.ok(out.tables.some((t) => t.label === 'groups'));
});

/** A statement naming no table is counted, not dropped. */
test('a query with no table still lands somewhere', () => {
  meter.recordQuery(result(rows(1)), 'BEGIN');
  meter.recordQuery(result([]), 'SELECT 1');
  const out = meter.usageByLabel();
  assert.equal(out.tables.length, 1);
  assert.equal(out.tables[0].label, 'other');
  assert.equal(out.tables[0].queries, 2);
});

/**
 * THE PARTS MUST SUM TO THE WHOLE. A breakdown that quietly loses bytes would
 * send somebody hunting for a table that is not the problem.
 */
test('every counted byte is attributed to something', () => {
  for (let i = 0; i < 30; i += 1) {
    meter.recordQuery(result(rows(3)), `SELECT * FROM t${i} WHERE x = $1`);
  }
  const out = meter.usageByLabel({ limit: 1000 });
  assert.equal(out.attributedBytes, meter.snapshot().bytes);
});

/**
 * A DIAGNOSTIC THAT GROWS WITHOUT LIMIT IS A MEMORY LEAK WEARING A CHART.
 * Past the cap the answer gets coarser; it never gets wrong.
 */
test('the label set is bounded, and the overflow still sums', () => {
  for (let i = 0; i < 300; i += 1) {
    meter.recordQuery(result(rows(1)), `SELECT * FROM table_${i}`);
  }
  const out = meter.usageByLabel({ limit: 1000 });
  assert.ok(out.tables.length <= 81, `expected the cap to hold, saw ${out.tables.length}`);
  assert.equal(out.attributedBytes, meter.snapshot().bytes,
    'the overflow bucket keeps the parts summing to the whole');
  assert.ok(out.tables.some((t) => t.label === 'other'));
});

/** The SQL is read for a table name and nothing else. */
test('NO FRAGMENT OF THE QUERY EVER BECOMES A LABEL', () => {
  meter.recordQuery(
    result(rows(1)),
    "SELECT * FROM finance_messages WHERE text = 'money code 1234 5678 for $500'",
  );
  const labels = meter.usageByLabel().tables.map((t) => t.label);
  assert.deepEqual(labels, ['finance_messages']);
  for (const leak of ['money', '1234', '500', 'text', 'WHERE']) {
    assert.ok(!labels.join(' ').includes(leak), `the label leaked "${leak}"`);
  }
});

/** The breakdown describes THIS process; a restart resets it, not the month. */
test('the breakdown is scoped to the process and says since when', () => {
  meter.recordQuery(result(rows(2)), 'SELECT * FROM groups');
  const before = meter.usageByLabel();
  assert.ok(Date.parse(before.since) > 0);
  meter.reset();
  assert.deepEqual(meter.usageByLabel().tables, []);
});

/** And it reaches the endpoint the admin reads. */
test('the usage report carries the breakdown', () => {
  meter.recordQuery(result(rows(4)), 'SELECT * FROM driver_people');
  const report = usageReport({ budgetBytes: 5 * GB });
  assert.equal(report.breakdown.tables[0].label, 'driver_people');
  assert.equal(report.breakdown.truncated, false);
});

// ── a keyword inside text is not SQL structure ──────────────────────────────

/**
 * THE CAPTURE SHAPE WAS NOT ENOUGH ON ITS OWN.
 *
 * `[A-Za-z_][A-Za-z0-9_$]*` guarantees the label LOOKS like an identifier and
 * guarantees nothing about where it came from: `alice_smith` is a well-formed
 * identifier and a person's name. A pattern is only SQL structure where SQL
 * structure is allowed, and inside a comment or a string it is neither.
 */
test('A KEYWORD INSIDE A COMMENT OR A STRING NEVER BECOMES A LABEL', () => {
  const cases = [
    ['/* report from Alice_Smith */ SELECT * FROM groups', 'groups'],
    ['-- fetch from Bob_Jones\nSELECT * FROM groups', 'groups'],
    ["SELECT 'sent from John_Doe'", 'other'],
    ["SELECT 'it''s from Mallory' FROM groups", 'groups'],
    ["SELECT * FROM finance_messages WHERE t = 'a--b from Eve'", 'finance_messages'],
    // Migrations wrap whole bodies in dollar quotes; the FROM inside one is
    // not the statement's own.
    ['DO $$ BEGIN SELECT 1 FROM secret_table; END $$; SELECT * FROM groups', 'groups'],
  ];
  for (const [sql, want] of cases) {
    meter.reset();
    meter.recordQuery(result(rows(1)), sql);
    assert.equal(meter.usageByLabel().tables[0].label, want, sql);
  }
});

/** Parameters are not dollar-quoted strings, and must survive. */
test('a $1 placeholder is not a dollar-quoted literal', () => {
  meter.recordQuery(result(rows(1)), 'SELECT * FROM groups WHERE id = $1 AND x = $2');
  assert.equal(meter.usageByLabel().tables[0].label, 'groups');
});

/** A double-quoted name is an IDENTIFIER in PostgreSQL, so it is kept. */
test('a quoted identifier is still a table', () => {
  meter.recordQuery(result(rows(1)), 'SELECT * FROM "Groups"');
  assert.equal(meter.usageByLabel().tables[0].label, 'groups');
});

/**
 * Unterminated anything runs to the end of the statement, which is the safe
 * direction: it can cost a label and it cannot leak one. The property under
 * test is NOT which of the two answers comes back — a real table before the
 * unterminated text is a perfectly good answer — it is that the text inside it
 * is never one of them.
 */
test('an unterminated comment or string can cost a label, never leak one', () => {
  for (const sql of [
    "SELECT * FROM groups WHERE t = 'from Trudy",
    '/* from Trudy SELECT * FROM groups',
    '-- from Trudy',
    'SELECT * FROM t WHERE x = $tag$ from Trudy',
  ]) {
    meter.reset();
    meter.recordQuery(result(rows(1)), sql);
    const label = meter.usageByLabel().tables[0].label;
    assert.ok(['groups', 't', 'other'].includes(label),
      `${sql} produced ${label}`);
    assert.ok(!label.includes('trudy'), `the label leaked a name: ${label}`);
  }
});
