const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function loadService({ profiles, parsedRows, classifications }) {
  const servicePath = path.resolve(__dirname, '../services/driverGroupAiSyncService.js');
  const dbPath = path.resolve(__dirname, '../database/db.js');
  const parserPath = path.resolve(__dirname, '../services/driverProfileAiParser.js');
  const classifierPath = path.resolve(__dirname, '../services/groupStatusAiClassifier.js');

  delete require.cache[servicePath];
  delete require.cache[dbPath];
  delete require.cache[parserPath];
  delete require.cache[classifierPath];

  const updates = [];
  require.cache[dbPath] = {
    exports: {
      listDriverProfiles: async () => profiles,
      updateDriverProfile: async (id, patch, opts) => {
        updates.push({ id, patch, opts });
        return { id, ...patch };
      },
    },
  };
  require.cache[parserPath] = {
    exports: {
      parseGroups: async () => parsedRows,
    },
  };
  require.cache[classifierPath] = {
    exports: {
      classifyDriverGroups: async () => classifications,
    },
  };

  const service = require(servicePath);
  return { ...service, updates };
}

test('runUnifiedDriverGroupAiSync updates status and identity fields together', async () => {
  const profiles = [{
    id: 1,
    group_id: 11,
    group_name: 'WENZE UNIT # 11 TERRELL DALTON (COMPANY DRIVER) INACTIVE',
    first_name: null,
    last_name: null,
    secondary_first_name: null,
    secondary_last_name: null,
    first_name_source: null,
    last_name_source: null,
    secondary_first_name_source: null,
    secondary_last_name_source: null,
    driver_type: 'owner',
    driver_type_source: null,
    unit_number: null,
    unit_number_source: null,
    status: 'active',
    status_source: 'bot',
  }];
  const parsedRows = [{
    group_id: 11,
    group_name: profiles[0].group_name,
    first_name: 'TERRELL',
    last_name: 'DALTON',
    secondary_first_name: null,
    secondary_last_name: null,
    driver_type: 'company_driver',
    unit_number: '11',
    source: 'ai',
  }];
  const classifications = new Map([[11, { active: false }]]);
  const { runUnifiedDriverGroupAiSync, updates } = loadService({ profiles, parsedRows, classifications });

  const result = await runUnifiedDriverGroupAiSync({ apply: true });

  assert.equal(result.updated, 1);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].patch.first_name, 'TERRELL');
  assert.deepEqual(updates[0].patch.last_name, 'DALTON');
  assert.deepEqual(updates[0].patch.driver_type, 'company_driver');
  assert.deepEqual(updates[0].patch.unit_number, '11');
  assert.deepEqual(updates[0].patch.status, 'inactive');
  assert.equal(updates[0].opts.groupStatusSource, 'ai');
});

test('runUnifiedDriverGroupAiSync preserves manual fields and manual status locks', async () => {
  const profiles = [{
    id: 2,
    group_id: 22,
    group_name: 'WENZE UNIT # 22 RUDOLPH FREDERIC / JOHN ELISEE',
    first_name: 'Rudy',
    last_name: 'Frederic',
    secondary_first_name: null,
    secondary_last_name: null,
    first_name_source: 'manual',
    last_name_source: 'manual',
    secondary_first_name_source: null,
    secondary_last_name_source: null,
    driver_type: 'owner',
    driver_type_source: 'manual',
    unit_number: '22',
    unit_number_source: 'manual',
    status: 'active',
    status_source: 'manual',
  }];
  const parsedRows = [{
    group_id: 22,
    group_name: profiles[0].group_name,
    first_name: 'RUDOLPH',
    last_name: 'FREDERIC',
    secondary_first_name: 'JOHN',
    secondary_last_name: 'ELISEE',
    driver_type: 'company_driver',
    unit_number: '222',
    source: 'ai',
  }];
  const classifications = new Map([[22, { active: false }]]);
  const { runUnifiedDriverGroupAiSync, updates } = loadService({ profiles, parsedRows, classifications });

  const result = await runUnifiedDriverGroupAiSync({ apply: true });

  assert.equal(result.updated, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].patch.first_name, undefined);
  assert.equal(updates[0].patch.last_name, undefined);
  assert.equal(updates[0].patch.driver_type, undefined);
  assert.equal(updates[0].patch.unit_number, undefined);
  assert.equal(updates[0].patch.status, undefined);
  assert.equal(updates[0].patch.secondary_first_name, 'JOHN');
  assert.equal(updates[0].patch.secondary_last_name, 'ELISEE');
});
