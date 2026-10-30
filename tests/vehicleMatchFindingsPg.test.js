/**
 * Samsara driver-match reports reach Needs Attention through the real sweep
 * against a real PostgreSQL: only OPEN name_mismatch / ambiguous_match rows
 * become findings, and a report the scan resolves resolves its finding on the
 * next sweep.
 *
 * Requires TEST_DATABASE_URL.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createPgHarness, skipWithoutPg, allMigrationsSql } = require('./helpers/pgHarness');
const { POOL_PATH, purgeDataLayer } = require('./helpers/purgeDataLayer');

const ALL_MIGRATIONS = allMigrationsSql();
const SERVICE_PATHS = [
  '../services/identity/personResolver', '../services/identity/personBackfillService',
  '../services/operations/consistencyService', '../services/operations/corrections/actions',
  '../services/operations/corrections/identityActions', '../services/operations/corrections/alertActions',
  '../services/operations/corrections/apply', '../services/operations/corrections/autoApply',
].map((p) => path.resolve(__dirname, `${p}.js`));

function bind(harness) {
  purgeDataLayer(SERVICE_PATHS);
  require.cache[POOL_PATH] = {
    id: POOL_PATH, filename: POOL_PATH, loaded: true,
    exports: { pool: harness.pool, query: harness.query, ping: async () => true },
  };
  try {
    const db = { pool: harness.pool, query: harness.query };
    const store = require('../database/operationalFindings');
    const { runConsistencySweep } = require('../services/operations/consistencyService');
    return { store, sweep: () => runConsistencySweep({ db, store }) };
  } finally {
    delete require.cache[POOL_PATH];
    purgeDataLayer(SERVICE_PATHS);
  }
}

async function addReport(harness, { unit, type, status = 'open', severity = 'warning', provider = null }) {
  await harness.query(
    `INSERT INTO duplicate_unit_reports
       (unit_number, report_type, group_ids, group_names, group_driver_name, provider, provider_driver_name, detail, severity, status)
     VALUES ($1, $2, '{}', '{}', 'Test Driver', 'samsara', $3, 'made up for the test', $4, $5)`,
    [unit, type, provider, severity, status]
  );
}

test('open driver-match reports become findings; resolving the report resolves the finding', { skip: skipWithoutPg(), timeout: 60000 }, async (t) => {
  const harness = await createPgHarness(t, { extraDdl: ALL_MIGRATIONS });
  const { store, sweep } = bind(harness);
  await addReport(harness, { unit: '901', type: 'name_mismatch', provider: 'Other Driver' });
  await addReport(harness, { unit: '902', type: 'ambiguous_match', severity: 'serious' });
  await addReport(harness, { unit: '903', type: 'name_mismatch', status: 'resolved' });
  await addReport(harness, { unit: '904', type: 'duplicate_unit' });

  await sweep();
  const open = async () => (await store.listFindings({ status: 'open', limit: 500 }))
    .filter((f) => f.checkKey.startsWith('samsara.driver_name') || f.checkKey.startsWith('samsara.ambiguous'))
    .map((f) => `${f.checkKey}:${f.subjectId}:${f.severity}`).sort();
  assert.deepEqual(await open(), [
    'samsara.ambiguous_unit_match:902:serious',
    'samsara.driver_name_mismatch:901:warning',
  ]);

  await harness.query("UPDATE duplicate_unit_reports SET status = 'resolved', resolved_at = NOW() WHERE unit_number = '901'");
  await sweep();
  assert.deepEqual(await open(), ['samsara.ambiguous_unit_match:902:serious']);
});
