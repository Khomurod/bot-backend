'use strict';

/**
 * Finance Monitor settings against the real schema.
 *
 * Three things here exist only in SQL or only in the interaction with it, so no
 * stub can prove them:
 *
 *   the singleton, the CHECK ranges and the seeded row are the migration's,
 *   not the module's — a JavaScript clamp that agreed with a CHECK that had
 *   drifted would test itself;
 *
 *   "enabled requires a validated chat" is the rule that keeps this from
 *   reading a group nobody confirmed, and it is enforced above SQL, so it has
 *   to be exercised against a real row;
 *
 *   `enabled_at` is stamped once and never moved, because the weekly report
 *   uses it to tell "no money codes that week" from "we were not watching that
 *   week" — opposite answers that would otherwise look identical.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function setup(t) {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const loaded = h.loadDataLayer(['financeSettings']);
  loaded.financeSettings.invalidateCache();
  return { h, ...loaded };
}

test('the migration seeds exactly one row, and a second is refused', { skip: skipWithoutPg() }, async (t) => {
  const { h } = await setup(t);
  const { rows } = await h.pool.query('SELECT id, enabled, chat_id FROM finance_settings');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 1);
  assert.equal(rows[0].enabled, false, 'a payment reader must not arrive switched on');
  assert.equal(rows[0].chat_id, null);

  await assert.rejects(() => h.pool.query('INSERT INTO finance_settings (id) VALUES (2)'));
});

test('it will not switch on without a validated chat', { skip: skipWithoutPg() }, async (t) => {
  const { financeSettings } = await setup(t);

  await assert.rejects(
    () => financeSettings.updateFinanceSettings({ enabled: true }),
    /Validate the finance group/,
  );
  // A chat id alone is not validation: somebody has to have confirmed the bot
  // can see that group and that it is the right one.
  await assert.rejects(
    () => financeSettings.updateFinanceSettings({ enabled: true, chatId: '-1009999' }),
    /Validate the finance group/,
  );

  const saved = await financeSettings.updateFinanceSettings({
    enabled: true, chatId: '-1009999', chatTitle: 'Finance', chatValidatedAt: new Date(),
  });
  assert.equal(saved.enabled, true);
  assert.equal(saved.chatId, '-1009999');
});

test('enabled_at is stamped once and never moved', { skip: skipWithoutPg() }, async (t) => {
  const { financeSettings, h } = await setup(t);

  const first = await financeSettings.updateFinanceSettings({
    enabled: true, chatId: '-100111', chatValidatedAt: new Date(),
  });
  assert.ok(first.enabledAt, 'switching on stamps it');
  const stamped = (await h.pool.query('SELECT enabled_at FROM finance_settings WHERE id=1')).rows[0].enabled_at;

  // Off and on again must NOT reset it. The weekly report reads this to tell
  // "nothing happened that week" from "we were not watching that week".
  await financeSettings.updateFinanceSettings({ enabled: false });
  await financeSettings.updateFinanceSettings({ enabled: true });
  const after = (await h.pool.query('SELECT enabled_at FROM finance_settings WHERE id=1')).rows[0].enabled_at;
  assert.equal(after.getTime(), stamped.getTime());
});

test('omitting a field keeps it — the house omit-means-keep rule', { skip: skipWithoutPg() }, async (t) => {
  const { financeSettings } = await setup(t);

  await financeSettings.updateFinanceSettings({
    chatId: '-100222', chatTitle: 'Finance', chatValidatedAt: new Date(),
    maxDocumentMb: 12, duplicateWindowHours: 24,
  });
  const after = await financeSettings.updateFinanceSettings({ captureDocuments: true });

  assert.equal(after.chatId, '-100222');
  assert.equal(after.chatTitle, 'Finance');
  assert.equal(after.maxDocumentMb, 12);
  assert.equal(after.duplicateWindowHours, 24);
  assert.equal(after.captureDocuments, true);
});

test('out-of-range numbers are clamped before they reach the CHECK', { skip: skipWithoutPg() }, async (t) => {
  const { financeSettings, h } = await setup(t);

  const high = await financeSettings.updateFinanceSettings({ maxDocumentMb: 500, duplicateWindowHours: 99999 });
  assert.equal(high.maxDocumentMb, 20);
  assert.equal(high.duplicateWindowHours, 8760);

  const low = await financeSettings.updateFinanceSettings({ maxDocumentMb: 0, duplicateWindowHours: 0 });
  assert.equal(low.maxDocumentMb, 1);
  assert.equal(low.duplicateWindowHours, 1);

  // And the CHECK is really there, so the clamp is a courtesy rather than the
  // only thing between a bad value and the table. Asserted through the pool,
  // not through the module — going through the module would just re-test the
  // clamp and call it a constraint.
  await assert.rejects(
    () => h.pool.query('UPDATE finance_settings SET max_document_mb = 99 WHERE id = 1'),
    /finance_settings_document_mb/,
  );
  await assert.rejects(
    () => h.pool.query('UPDATE finance_settings SET duplicate_window_hours = 0 WHERE id = 1'),
    /finance_settings_duplicate_window/,
  );
});

test('isFinanceChat answers false for every chat until it is on AND pointed somewhere', { skip: skipWithoutPg() }, async (t) => {
  const { financeSettings } = await setup(t);

  assert.equal(await financeSettings.isFinanceChat('-100333'), false, 'off by default');

  await financeSettings.updateFinanceSettings({ chatId: '-100333', chatValidatedAt: new Date() });
  financeSettings.invalidateCache();
  assert.equal(await financeSettings.isFinanceChat('-100333'), false, 'configured but still off');

  await financeSettings.updateFinanceSettings({ enabled: true });
  financeSettings.invalidateCache();
  assert.equal(await financeSettings.isFinanceChat('-100333'), true);
  assert.equal(await financeSettings.isFinanceChat('-100444'), false, 'and only that chat');
  assert.equal(await financeSettings.isFinanceChat(-100333), true, 'number or string, same chat');
});

test('a missing table reads as unconfigured — and ONLY a missing table does', { skip: skipWithoutPg() }, async (t) => {
  const { financeSettings, h } = await setup(t);

  // The flaw this module was written not to repeat: six older settings modules
  // catch EVERY error from their single-row read and answer null, so a
  // transient outage reads as "the operator turned this off". Only 42P01 — the
  // relation does not exist — may answer that way.
  financeSettings.invalidateCache();
  await h.pool.query('ALTER TABLE finance_settings RENAME TO finance_settings_hidden');
  try {
    const out = await financeSettings.getFinanceSettings();
    assert.equal(out.enabled, false, '42P01 really does read as unconfigured');
    assert.equal(out.chatId, null);
  } finally {
    await h.pool.query('ALTER TABLE finance_settings_hidden RENAME TO finance_settings');
  }

  // Every OTHER failure is rethrown. The read is `SELECT *`, which survives a
  // renamed column, so the failure is injected by putting a VIEW of that name
  // in the table's place whose evaluation raises — division_by_zero (22012).
  // A different error through the same code path, and exactly the kind that
  // must NOT be mistaken for "the operator switched this off".
  financeSettings.invalidateCache();
  await h.pool.query('ALTER TABLE finance_settings RENAME TO finance_settings_real');
  await h.pool.query('CREATE VIEW finance_settings AS SELECT (1 / (random() * 0)::int) AS id');
  try {
    await assert.rejects(
      () => financeSettings.getFinanceSettings(),
      (err) => {
        assert.notEqual(err.code, '42P01', 'this must not be re-proving the 42P01 branch');
        assert.equal(err.code, '22012', 'and it must be the failure that was injected');
        return true;
      },
      'a failure that is not a missing table must reach the caller',
    );
  } finally {
    await h.pool.query('DROP VIEW IF EXISTS finance_settings');
    await h.pool.query('ALTER TABLE finance_settings_real RENAME TO finance_settings');
    financeSettings.invalidateCache();
  }
});
