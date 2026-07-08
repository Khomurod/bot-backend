/**
 * Tests for database/bolPodMonitorSettings.js — the single-row (id=1) store that
 * backs the silent BOL/POD test monitor. `./db` is replaced in the require cache
 * with an in-memory fake so no real Postgres is needed. Covers: default read,
 * update (persist), invalid group-id rejection, unexpected-field rejection,
 * and the fail-safe (disabled) when the row/table is unavailable.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadWithFakeDb({ startRow, failing = false } = {}) {
  // Seeded default row (mirrors the schema DEFAULTs).
  const row = startRow === null ? null : {
    id: 1,
    test_monitor_enabled: false,
    test_group_id: '-5289094495',
    test_send_unrelated: true,
    test_send_unclear: true,
    test_send_files: true,
    last_report_at: null,
    report_count: 0,
    updated_at: '2026-01-01T00:00:00Z',
    updated_by: null,
    ...(startRow || {}),
  };
  const state = { row, calls: [] };

  const query = async (text, params = []) => {
    state.calls.push({ text, params });
    if (failing) throw new Error('DB down');
    if (/^\s*SELECT/i.test(text)) {
      return { rows: state.row ? [{ ...state.row }] : [] };
    }
    if (/^\s*UPDATE/i.test(text)) {
      if (!state.row) state.row = { id: 1 };
      // Apply "col = $n" assignments.
      for (const m of text.matchAll(/(\w+)\s*=\s*\$(\d+)/g)) {
        state.row[m[1]] = params[Number(m[2]) - 1];
      }
      // Apply "col = NOW()" / increments.
      if (/updated_at\s*=\s*NOW\(\)/i.test(text)) state.row.updated_at = 'NOW';
      const inc = text.match(/report_count\s*=\s*report_count\s*\+\s*\$(\d+)/);
      if (inc) state.row.report_count = (Number(state.row.report_count) || 0) + Number(params[Number(inc[1]) - 1] || 1);
      if (/last_report_at\s*=\s*NOW\(\)/i.test(text)) state.row.last_report_at = 'NOW';
      return { rows: [{ ...state.row }] };
    }
    return { rows: [] };
  };

  const dbPath = require.resolve(path.resolve(__dirname, '../database/db.js'));
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query } };

  const modPath = require.resolve(path.resolve(__dirname, '../database/bolPodMonitorSettings.js'));
  delete require.cache[modPath];
  const mod = require(modPath);
  mod.invalidateCache();
  return { mod, state };
}

test('default settings read maps the seeded row', async () => {
  const { mod } = loadWithFakeDb();
  const s = await mod.getSettingsForAdmin();
  assert.equal(s.enabled, false);
  assert.equal(s.testGroupId, '-5289094495');
  assert.equal(s.sendUnrelated, true);
  assert.equal(s.sendUnclear, true);
  assert.equal(s.sendFiles, true);
  assert.equal(s.loaded, true);
});

test('update settings persists the new values', async () => {
  const { mod } = loadWithFakeDb();
  const s = await mod.updateSettings({
    test_monitor_enabled: true,
    test_group_id: '-1002222',
    test_send_unrelated: false,
    test_send_unclear: false,
    test_send_files: false,
  }, 'admin');
  assert.equal(s.enabled, true);
  assert.equal(s.testGroupId, '-1002222');
  assert.equal(s.sendUnrelated, false);
  assert.equal(s.sendUnclear, false);
  assert.equal(s.sendFiles, false);
  assert.equal(s.updatedBy, 'admin');
  // Re-read reflects persistence.
  const again = await mod.getSettingsForAdmin();
  assert.equal(again.enabled, true);
  assert.equal(again.testGroupId, '-1002222');
});

test('invalid test_group_id is rejected (400)', async () => {
  const { mod } = loadWithFakeDb();
  await assert.rejects(
    () => mod.updateSettings({ test_group_id: 'not-a-number' }, 'admin'),
    (err) => { assert.equal(err.statusCode, 400); return /valid Telegram chat id/i.test(err.message); }
  );
});

test('unexpected fields are ignored (never written)', async () => {
  const { mod, state } = loadWithFakeDb();
  await mod.updateSettings({ test_monitor_enabled: true, hacker_column: 'DROP', id: 999 }, 'admin');
  const update = state.calls.find((c) => /^\s*UPDATE/i.test(c.text));
  assert.ok(update, 'an UPDATE ran');
  const setClause = update.text.split(/\bWHERE\b/i)[0]; // exclude the WHERE id = 1 guard
  assert.doesNotMatch(setClause, /hacker_column/);
  assert.doesNotMatch(setClause, /\bid\s*=/); // id is never in the SET list
});

test('boolean-only fields must be booleans (a string is ignored)', async () => {
  const { mod, state } = loadWithFakeDb();
  await mod.updateSettings({ test_monitor_enabled: 'true' }, 'admin'); // string, not bool
  const update = state.calls.find((c) => /^\s*UPDATE/i.test(c.text));
  // Only updated_at/updated_by should be set (no test_monitor_enabled column).
  assert.doesNotMatch(update.text, /test_monitor_enabled\s*=/);
});

test('recordReportSent bumps count + timestamp', async () => {
  const { mod } = loadWithFakeDb({ startRow: { report_count: 4 } });
  await mod.recordReportSent(1);
  const s = await mod.getSettingsForAdmin();
  assert.equal(s.reportCount, 5);
  assert.equal(s.lastReportAt, 'NOW');
});

test('fail-safe: DB error → disabled settings, loaded:false', async () => {
  const { mod } = loadWithFakeDb({ failing: true });
  const s = await mod.getEffectiveSettings();
  assert.equal(s.enabled, false);
  assert.equal(s.loaded, false);
  assert.equal(s.testGroupId, '-5289094495'); // safe default
});

test('fail-safe: missing row → disabled settings', async () => {
  const { mod } = loadWithFakeDb({ startRow: null });
  const s = await mod.getEffectiveSettings();
  assert.equal(s.enabled, false);
  assert.equal(s.loaded, false);
});
