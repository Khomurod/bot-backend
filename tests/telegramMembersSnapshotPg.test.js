'use strict';

/**
 * The sweep's member read against a real PostgreSQL: it returns exactly what
 * `tests/helpers/telegramMembersModel.js` says — the model the
 * decision-equivalence test (`telegramMembersNarrowing.test.js`) proves files
 * the same findings as the whole table.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { asTheLoaderReadsIt, fleet } = require('./helpers/telegramMembersModel');

const ALL_MIGRATIONS = allMigrationsSql();
const key = (m) => `${m.group_id}:${m.telegram_user_id}`;

test('the member read returns only who could be a driver, and every chat they are in', { skip: skipWithoutPg() }, async (t) => {
  const h = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const whole = fleet();
  for (const g of whole.groups) {
    // eslint-disable-next-line no-await-in-loop
    await h.query(
      'INSERT INTO groups (id, telegram_group_id, group_name, group_type, active) VALUES ($1, $2, $3, $4, $5)',
      [g.id, -1000 - g.id, g.group_name, g.group_type, g.active]
    );
  }
  for (const m of whole.groupMembers) {
    // eslint-disable-next-line no-await-in-loop
    await h.query(
      'INSERT INTO group_members (group_id, telegram_user_id, first_name, last_name) VALUES ($1, $2, $3, $4)',
      [m.group_id, m.telegram_user_id, m.first_name, m.last_name]
    );
  }
  for (const u of whole.botUsers) {
    // eslint-disable-next-line no-await-in-loop
    await h.query('INSERT INTO bot_users (telegram_user_id, source) VALUES ($1, $2)', [u.telegram_user_id, u.source]);
  }

  // eslint-disable-next-line global-require
  const { loadLayerSnapshot } = require('../services/operations/snapshot/loaders');
  const layer = await loadLayerSnapshot({ query: h.query });
  const expected = asTheLoaderReadsIt(whole);

  assert.deepEqual(layer.groupMembers.map(key).sort(), expected.groupMembers.map(key).sort());
  assert.deepEqual(
    layer.botUsers.map((u) => `${u.telegram_user_id}:${u.source}`).sort(),
    expected.botUsers.map((u) => `${u.telegram_user_id}:${u.source}`).sort()
  );
});
