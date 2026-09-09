/**
 * Abandoning the undeliverable pile, against a real PostgreSQL.
 *
 * The state change is one word, so everything that matters here is about what
 * it must NOT do: not re-send, not delete, not touch a row somebody has since
 * rescued, and not become irreversible.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');

const ALL_MIGRATIONS = allMigrationsSql();

async function seed(harness, states) {
  await harness.query(
    `INSERT INTO groups (id, telegram_group_id, group_name, group_type, active)
     VALUES (1, '-100', 'WENZE UNIT # 5 PAT D', 'driver', TRUE)`
  );
  const ids = [];
  for (const state of states) {
    // eslint-disable-next-line no-await-in-loop
    const res = await harness.query(
      `INSERT INTO home_time_requests
         (group_id, telegram_group_id, status, source,
          internal_alert_state, internal_alert_attempts, internal_alert_last_error)
       VALUES (1, '-100', 'awaiting_dates', 'telegram', $1, 6, '400: Bad Request: chat not found')
       RETURNING id`,
      [state]
    );
    ids.push(res.rows[0].id);
  }
  return ids;
}

function loadApply(harness) {
  const layer = harness.loadDataLayer(['operationalCorrections', 'operationalFindings', 'adminAudit']);
  return { layer };
}

test("'abandoned' is a state the schema accepts", { skip: skipWithoutPg() }, async (t) => {
  // Migration 0022 widens a CHECK that was created inline in 0002 and carries
  // Postgres's generated name, so it is discovered rather than assumed.
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const [id] = await seed(harness, ['failed']);
  await harness.query("UPDATE home_time_requests SET internal_alert_state = 'abandoned' WHERE id = $1", [id]);
  const res = await harness.query('SELECT internal_alert_state FROM home_time_requests WHERE id = $1', [id]);
  assert.equal(res.rows[0].internal_alert_state, 'abandoned');
});

test('the widened CHECK still refuses a state nobody defined', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const [id] = await seed(harness, ['failed']);
  await assert.rejects(
    () => harness.query("UPDATE home_time_requests SET internal_alert_state = 'whatever' WHERE id = $1", [id]),
    (err) => err.code === '23514',
    'widening a constraint must not mean removing it'
  );
});

test('apply moves only the exhausted rows, and keeps their evidence', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const ids = await seed(harness, ['failed', 'failed', 'delivered', 'pending']);
  const { abandonExhaustedInternalAlerts } = require('../services/operations/corrections/alertActions');

  const client = await harness.connect();
  let result;
  try {
    result = await abandonExhaustedInternalAlerts.apply({ requestIds: ids }, client);
  } finally {
    client.release();
  }

  assert.deepEqual(result.oldValues.requestIds, [ids[0], ids[1]],
    'a delivered or still-pending alert is not swept up with them');

  const rows = await harness.query(
    'SELECT id, internal_alert_state, internal_alert_attempts, internal_alert_last_error '
    + 'FROM home_time_requests ORDER BY id'
  );
  assert.deepEqual(rows.rows.map((r) => r.internal_alert_state),
    ['abandoned', 'abandoned', 'delivered', 'pending']);
  for (const row of rows.rows.slice(0, 2)) {
    assert.equal(row.internal_alert_attempts, 6, 'nothing is deleted — what was lost stays answerable');
    assert.match(row.internal_alert_last_error, /chat not found/);
  }
});

test('a row rescued since the sweep is left alone', { skip: skipWithoutPg() }, async (t) => {
  // The drain runs every few minutes; one of these could be re-driven and
  // delivered between the sweep and the apply. Evidence is re-derived from the
  // live rows rather than trusted from the payload.
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const ids = await seed(harness, ['failed', 'delivered']);
  const { abandonExhaustedInternalAlerts } = require('../services/operations/corrections/alertActions');

  const client = await harness.connect();
  try {
    const result = await abandonExhaustedInternalAlerts.apply({ requestIds: ids }, client);
    assert.deepEqual(result.oldValues.requestIds, [ids[0]]);
  } finally {
    client.release();
  }
});

test('nothing left to abandon is a stand-down, not a write', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const ids = await seed(harness, ['delivered']);
  const { abandonExhaustedInternalAlerts } = require('../services/operations/corrections/alertActions');
  const { StaleCorrectionError } = require('../services/operations/corrections/evidence');

  const client = await harness.connect();
  try {
    await assert.rejects(
      () => abandonExhaustedInternalAlerts.apply({ requestIds: ids }, client),
      (err) => err instanceof StaleCorrectionError
    );
  } finally {
    client.release();
  }
});

test('revert puts back exactly what it moved', { skip: skipWithoutPg() }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const ids = await seed(harness, ['failed', 'failed', 'delivered']);
  const { abandonExhaustedInternalAlerts } = require('../services/operations/corrections/alertActions');

  const client = await harness.connect();
  try {
    const result = await abandonExhaustedInternalAlerts.apply({ requestIds: ids }, client);
    await abandonExhaustedInternalAlerts.revert(
      { subject_id: 'home_time_internal_alerts', old_values: result.oldValues, new_values: result.newValues },
      client
    );
  } finally {
    client.release();
  }

  const rows = await harness.query('SELECT internal_alert_state FROM home_time_requests ORDER BY id');
  assert.deepEqual(rows.rows.map((r) => r.internal_alert_state), ['failed', 'failed', 'delivered'],
    'byte-identical to before the apply');
});

test('revert refuses a row somebody has since re-driven', { skip: skipWithoutPg() }, async (t) => {
  // Undoing "we gave up" must not drag back a row a person deliberately rescued.
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const ids = await seed(harness, ['failed', 'failed']);
  const { abandonExhaustedInternalAlerts } = require('../services/operations/corrections/alertActions');
  const { StaleCorrectionError } = require('../services/operations/corrections/evidence');

  const client = await harness.connect();
  try {
    const result = await abandonExhaustedInternalAlerts.apply({ requestIds: ids }, client);
    await harness.query(
      "UPDATE home_time_requests SET internal_alert_state = 'pending' WHERE id = $1", [ids[1]]
    );
    await assert.rejects(
      () => abandonExhaustedInternalAlerts.revert(
        { subject_id: 'home_time_internal_alerts', old_values: result.oldValues, new_values: result.newValues },
        client
      ),
      (err) => err instanceof StaleCorrectionError
    );
  } finally {
    client.release();
  }
});
