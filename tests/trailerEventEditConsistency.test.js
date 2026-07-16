/**
 * Admin event-edit consistency (database/trailers.js updateTrailerEvent).
 * A pickup/dropoff event's possession MUST follow its type — contradictory
 * records (event_type=pickup + possession_status=dropped) are normalized away
 * server-side, cargo is admin-editable, and the audit snapshot is preserved.
 * The raw pg pool is replaced with a keyword-routed fake.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DATABASE_DIR = path.resolve(__dirname, '../database');

/** Every .js file under database/, recursively. */
function databaseFiles(dir = DATABASE_DIR) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...databaseFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function load(fakeQuery) {
  const modPath = path.resolve(__dirname, '../database/trailers.js');
  const poolPath = path.resolve(__dirname, '../database/pool.js');
  // trailers.js is a façade over database/trailerMasterList/*, so purging only
  // the façade would leave those modules bound to a PREVIOUS load's pool and
  // the fake below would be silently ignored. Purge the whole tree.
  for (const file of databaseFiles()) delete require.cache[file];
  delete require.cache[modPath];
  require.cache[poolPath] = { exports: { query: fakeQuery, pool: {}, ping: async () => true } };
  return require(modPath);
}

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

/** SET-clause param value for a column in the recorded UPDATE. */
function setParam(call, column) {
  const m = call.sql.match(new RegExp(`${column} = \\$(\\d+)`));
  return m ? call.params[Number(m[1]) - 1] : undefined;
}

const EXISTING_DROPOFF = {
  id: 9, event_type: 'dropoff', possession_status: 'dropped', cargo_status: 'empty',
  trailer_id: 100, original_event_snapshot: null,
};
const EXISTING_PICKUP = {
  id: 9, event_type: 'pickup', possession_status: 'with_driver', cargo_status: 'unknown',
  trailer_id: 100, original_event_snapshot: null,
};

test('changing event type to pickup forces possession_status=with_driver', async () => {
  const rec = recorder((s) => {
    if (s.startsWith('SELECT * FROM trailer_events WHERE id')) return [EXISTING_DROPOFF];
    if (s.startsWith('UPDATE trailer_events SET')) return [{ ...EXISTING_DROPOFF, event_type: 'pickup', possession_status: 'with_driver' }];
    return [];
  });
  const db = load(rec.query);
  await db.updateTrailerEvent(9, { event_type: 'pickup' }, { correctedBy: 'admin' });
  const upd = rec.calls.find((c) => c.sql.startsWith('UPDATE trailer_events SET'));
  assert.ok(upd, 'update ran');
  assert.equal(setParam(upd, 'event_type'), 'pickup');
  assert.equal(setParam(upd, 'possession_status'), 'with_driver');
});

test('changing event type to dropoff forces possession_status=dropped (+empty default)', async () => {
  const existing = { ...EXISTING_PICKUP, cargo_status: 'unknown' };
  const rec = recorder((s) => {
    if (s.startsWith('SELECT * FROM trailer_events WHERE id')) return [existing];
    if (s.startsWith('UPDATE trailer_events SET')) return [{ ...existing, event_type: 'dropoff' }];
    return [];
  });
  const db = load(rec.query);
  await db.updateTrailerEvent(9, { event_type: 'dropoff' }, { correctedBy: 'admin' });
  const upd = rec.calls.find((c) => c.sql.startsWith('UPDATE trailer_events SET'));
  assert.equal(setParam(upd, 'possession_status'), 'dropped');
  // dropoff with unknown cargo → business default empty
  assert.equal(setParam(upd, 'cargo_status'), 'empty');
});

test('contradictory patch (pickup + possession dropped) is normalized to with_driver', async () => {
  const rec = recorder((s) => {
    if (s.startsWith('SELECT * FROM trailer_events WHERE id')) return [EXISTING_DROPOFF];
    if (s.startsWith('UPDATE trailer_events SET')) return [{ ...EXISTING_DROPOFF, event_type: 'pickup' }];
    return [];
  });
  const db = load(rec.query);
  await db.updateTrailerEvent(9, { event_type: 'pickup', possession_status: 'dropped' }, { correctedBy: 'admin' });
  const upd = rec.calls.find((c) => c.sql.startsWith('UPDATE trailer_events SET'));
  assert.equal(setParam(upd, 'possession_status'), 'with_driver', 'server must override the contradiction');
});

test('admin can edit cargo_status (empty/loaded/unknown, normalized)', async () => {
  const rec = recorder((s) => {
    if (s.startsWith('SELECT * FROM trailer_events WHERE id')) return [EXISTING_DROPOFF];
    if (s.startsWith('UPDATE trailer_events SET')) return [{ ...EXISTING_DROPOFF, cargo_status: 'loaded' }];
    return [];
  });
  const db = load(rec.query);
  await db.updateTrailerEvent(9, { cargo_status: 'LOADED' }, { correctedBy: 'admin' });
  const upd = rec.calls.find((c) => c.sql.startsWith('UPDATE trailer_events SET'));
  assert.equal(setParam(upd, 'cargo_status'), 'loaded');
  // Editing cargo alone never flips possession away from the event type.
  assert.equal(setParam(upd, 'possession_status'), undefined);
});

test('garbage cargo_status collapses to unknown', async () => {
  const rec = recorder((s) => {
    if (s.startsWith('SELECT * FROM trailer_events WHERE id')) return [EXISTING_DROPOFF];
    if (s.startsWith('UPDATE trailer_events SET')) return [EXISTING_DROPOFF];
    return [];
  });
  const db = load(rec.query);
  await db.updateTrailerEvent(9, { cargo_status: 'banana' }, { correctedBy: 'admin' });
  const upd = rec.calls.find((c) => c.sql.startsWith('UPDATE trailer_events SET'));
  assert.equal(setParam(upd, 'cargo_status'), 'unknown');
});

test('edit records corrected_by, one-time original snapshot, and marks edited', async () => {
  const rec = recorder((s) => {
    if (s.startsWith('SELECT * FROM trailer_events WHERE id')) return [EXISTING_DROPOFF];
    if (s.startsWith('UPDATE trailer_events SET')) return [EXISTING_DROPOFF];
    return [];
  });
  const db = load(rec.query);
  await db.updateTrailerEvent(9, { event_type: 'pickup' }, { correctedBy: 'boss', correctionNote: 'wrong type' });
  const upd = rec.calls.find((c) => c.sql.startsWith('UPDATE trailer_events SET'));
  assert.equal(setParam(upd, 'corrected_by'), 'boss');
  assert.equal(setParam(upd, 'correction_note'), 'wrong type');
  assert.match(upd.sql, /corrected_at = NOW\(\)/);
  const snapshot = setParam(upd, 'original_event_snapshot');
  assert.ok(snapshot && JSON.parse(snapshot).event_type === 'dropoff', 'pre-edit row snapshotted');
  assert.equal(setParam(upd, 'review_status'), 'edited');
});

test('recomputeTrailerCurrentStatus uses the latest non-declined pickup/dropoff', async () => {
  const latest = {
    id: 12, event_type: 'pickup', possession_status: 'with_driver', cargo_status: 'unknown',
    trailer_id: 100, event_time: '2026-07-01T00:00:00Z', review_status: 'edited',
  };
  const rec = recorder((s) => {
    if (s.includes("review_status <> 'declined'")) return [latest];
    if (s.startsWith('SELECT * FROM trailers WHERE id')) return [{ id: 100, unit_number: 'ST508998' }];
    if (s.startsWith('INSERT INTO trailer_current_status')) return [{ trailer_id: 100, possession_status: 'with_driver' }];
    return [];
  });
  const db = load(rec.query);
  const status = await db.recomputeTrailerCurrentStatus(100);
  assert.ok(status);
  const ins = rec.calls.find((c) => c.sql.startsWith('INSERT INTO trailer_current_status'));
  assert.ok(ins.params.includes('with_driver'));
});
