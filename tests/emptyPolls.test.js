'use strict';

/**
 * Timers that ask the database "is anything due?" every minute or two, and
 * nearly always hear "no".
 *
 * October 2026, with the hosted database's transfer allowance nearly spent:
 * an empty answer still carries a description of every column the statement
 * would have returned. `SELECT * FROM scheduled_messages` described 22 columns
 * every minute; the dispatch-ETA claim described 18 every ninety seconds, with
 * no ETA schedule switched on at all. These pin the cheap shapes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const POOL = path.resolve(__dirname, '../database/pool.js');

function loadWith(modulePath, respond) {
  const sent = [];
  const full = path.resolve(__dirname, modulePath);
  delete require.cache[full];
  require.cache[POOL] = {
    id: POOL, filename: POOL, loaded: true,
    exports: { query: async (text, params) => { sent.push(text.replace(/\s+/g, ' ').trim()); return respond(text, params); } },
  };
  try {
    // eslint-disable-next-line global-require
    return { mod: require(full), sent };
  } finally {
    delete require.cache[POOL];
  }
}

test('NOTHING DUE: the ETA poll is one one-column look, and claims nothing', async () => {
  const { mod, sent } = loadWith('../database/dispatchEta.js', () => ({ rows: [], rowCount: 0 }));
  assert.deepEqual(await mod.claimDueDispatchEtaUpdates(20), []);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^SELECT 1 FROM dispatch_eta_updates WHERE enabled = TRUE .* LIMIT 1$/);
});

test('something due: the claim runs, under the same predicate as the look', async () => {
  const { mod, sent } = loadWith('../database/dispatchEta.js', (text) => (
    /^SELECT 1/.test(text.trim()) ? { rows: [{ '?column?': 1 }], rowCount: 1 } : { rows: [{ id: 3 }], rowCount: 1 }
  ));
  assert.deepEqual(await mod.claimDueDispatchEtaUpdates(20), [{ id: 3 }]);
  assert.equal(sent.length, 2);
  const predicate = sent[0].match(/WHERE (.*) LIMIT 1$/)[1];
  assert.ok(sent[1].includes(predicate), 'the look and the claim cannot disagree about what is due');
  assert.match(sent[1], /FOR UPDATE SKIP LOCKED/);
});

test('the scheduler\'s minute poll asks for ids only — the claim returns the row', async () => {
  const { mod, sent } = loadWith('../database/scheduledMessages.js', () => ({ rows: [], rowCount: 0 }));
  await mod.getPendingScheduledMessages();
  assert.match(sent[0], /^SELECT id FROM scheduled_messages WHERE status = 'pending' AND scheduled_at <= NOW\(\)/);
});
