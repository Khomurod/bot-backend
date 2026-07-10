/**
 * Unit tests for database/trailers.js. The raw pg pool is replaced with a
 * keyword-routed in-memory fake so the module's SQL/param shaping and business
 * rules are validated without a live database.
 *
 * Covered: upsert-by-unit blank guard, event insert + reporter/condition fields,
 * message dedupe, and current-status derivation (pickup/dropoff only).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function load(fakeQuery) {
  const modPath = path.resolve(__dirname, '../database/trailers.js');
  const poolPath = path.resolve(__dirname, '../database/pool.js');
  delete require.cache[modPath];
  require.cache[poolPath] = { exports: { query: fakeQuery, pool: {}, ping: async () => true } };
  return require(modPath);
}

/** Records every call and returns configurable rows keyed by a matcher. */
function recorder(handler) {
  const calls = [];
  const query = async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: s, params });
    const rows = handler(s, params) || [];
    return { rows, rowCount: rows.length };
  };
  return { query, calls };
}

test('upsertTrailerByUnitNumber (new) inserts only non-blank fields', async () => {
  const rec = recorder((s) => {
    if (s.startsWith('SELECT * FROM trailers WHERE unit_number')) return []; // not existing
    if (s.startsWith('INSERT INTO trailers')) return [{ id: 1, unit_number: 'ST508998' }];
    return [];
  });
  const db = load(rec.query);
  await db.upsertTrailerByUnitNumber({ unit_number: 'st508998', make: 'Wabash', model: '', vin: '   ' });
  const insert = rec.calls.find((c) => c.sql.startsWith('INSERT INTO trailers'));
  assert.ok(insert, 'insert ran');
  // 'make' present, blank 'model'/'vin' excluded from the column list.
  assert.match(insert.sql, /make/);
  assert.doesNotMatch(insert.sql, /model/);
  assert.doesNotMatch(insert.sql, /vin/);
  assert.ok(insert.params.includes('Wabash'));
  assert.ok(insert.params.includes('ST508998')); // normalized unit
});

test('upsertTrailerByUnitNumber (existing) never overwrites with blanks', async () => {
  const existing = { id: 7, unit_number: 'VT700669', make: 'Great Dane', plate_number: 'ABC123', source: 'admin_manual' };
  const rec = recorder((s) => {
    if (s.startsWith('SELECT * FROM trailers WHERE unit_number')) return [existing];
    if (s.startsWith('UPDATE trailers SET')) return [{ ...existing, model: 'X' }];
    return [];
  });
  const db = load(rec.query);
  await db.upsertTrailerByUnitNumber({ unit_number: 'VT700669', make: '', model: 'X', plate_number: null });
  const upd = rec.calls.find((c) => c.sql.startsWith('UPDATE trailers SET'));
  assert.ok(upd, 'update ran');
  assert.match(upd.sql, /model/);        // provided non-blank → written
  assert.doesNotMatch(upd.sql, /make =/); // blank → skipped
  assert.doesNotMatch(upd.sql, /plate_number =/); // null → skipped
});

test('insertTrailerEvent stores reporter + condition fields', async () => {
  const rec = recorder((s) => {
    if (s.startsWith('SELECT * FROM trailer_events WHERE telegram_group_id')) return []; // no dupe
    if (s.startsWith('INSERT INTO trailer_events')) return [{ id: 55, event_type: 'dropoff' }];
    return [];
  });
  const db = load(rec.query);
  const { event, duplicate } = await db.insertTrailerEvent({
    trailer_unit_number: 'ST508998', event_type: 'dropoff',
    telegram_group_id: -100123, telegram_message_id: 42,
    reported_by_username: 'enicson', reported_by_name: 'Enicson Jean',
    condition_text: 'no pictures', location_text: 'Lancaster PA', confidence: 95,
  });
  assert.equal(duplicate, false);
  assert.equal(event.id, 55);
  const ins = rec.calls.find((c) => c.sql.startsWith('INSERT INTO trailer_events'));
  assert.ok(ins.params.includes('Enicson Jean'));
  assert.ok(ins.params.includes('no pictures'));
  assert.ok(ins.params.includes('Lancaster PA'));
});

test('insertTrailerEvent dedupes the same Telegram message (no INSERT)', async () => {
  const rec = recorder((s) => {
    if (s.startsWith('SELECT * FROM trailer_events WHERE telegram_group_id')) {
      return [{ id: 9, event_type: 'pickup' }]; // an event already exists
    }
    return [];
  });
  const db = load(rec.query);
  const { event, duplicate } = await db.insertTrailerEvent({
    trailer_unit_number: 'VT700669', event_type: 'pickup',
    telegram_group_id: -100, telegram_message_id: 1,
  });
  assert.equal(duplicate, true);
  assert.equal(event.id, 9);
  assert.ok(!rec.calls.some((c) => c.sql.startsWith('INSERT INTO trailer_events')), 'no insert on dedupe');
});

test('applyEventToCurrentStatus writes for pickup → with_driver', async () => {
  const rec = recorder((s) => {
    if (s.startsWith('INSERT INTO trailer_current_status')) return [{ trailer_id: 1, current_status: 'with_driver' }];
    return [];
  });
  const db = load(rec.query);
  const row = await db.applyEventToCurrentStatus(
    { id: 1, unit_number: 'ST1' },
    { id: 10, event_type: 'pickup', created_at: '2026-07-10T00:00:00Z' }
  );
  assert.equal(row.current_status, 'with_driver');
  const ins = rec.calls.find((c) => c.sql.startsWith('INSERT INTO trailer_current_status'));
  assert.ok(ins.params.includes('with_driver'));
});

test('applyEventToCurrentStatus ignores mention/unidentified events', async () => {
  const rec = recorder(() => []);
  const db = load(rec.query);
  const row = await db.applyEventToCurrentStatus({ id: 1, unit_number: 'ST1' }, { id: 2, event_type: 'unidentified' });
  assert.equal(row, null);
  assert.equal(rec.calls.length, 0);
});

test('ensureTrailerForDetection creates minimal telegram_detected trailer', async () => {
  const rec = recorder((s) => {
    if (s.startsWith('SELECT * FROM trailers WHERE unit_number')) return []; // not existing
    if (s.startsWith('INSERT INTO trailers')) return [{ id: 3, unit_number: 'VM709984', source: 'telegram_detected', needs_review: true }];
    return [];
  });
  const db = load(rec.query);
  const t = await db.ensureTrailerForDetection('vm709984');
  assert.equal(t.source, 'telegram_detected');
  assert.equal(t.needs_review, true);
});
