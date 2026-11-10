'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEAL_FIELDS, FLEET_BY_DRIVER_TYPE, STATIC_SCHEMA, STAGE,
} = require('../lib/boardBitrix/vocabulary');
const { catalogSignature, fingerprint, labelOf } = require('../lib/boardBitrix/schema');
const { discoverBitrixSchema } = require('../services/boardBitrix/schemaDiscovery');
const { bitrixStatusRows } = require('./helpers/bitrixStatusRows');
const { normalizeStageRows } = require('../lib/boardBitrix/stageCodes');

/** Stage rows as discovery holds them after reading Bitrix's answer. */
const readAs = (rows, entity, categoryId = null) => (
  normalizeStageRows(bitrixStatusRows(rows, entity), { categoryId }).rows
);

function opaqueTruckCatalog() {
  return {
    categories: [{ id: 3, name: '4. DRIVER RELATION' }],
    types: [{ entityTypeId: 1040, name: '', title: 'Trucks' }],
    fields: {
      [DEAL_FIELDS.truck]: { title: 'Assigned Truck' },
      [DEAL_FIELDS.driverType]: {
        title: 'Driver Type', items: [
          { ID: '361', VALUE: 'Company Driver' },
          { ID: '363', VALUE: 'Owner Operator' },
          { ID: '395', VALUE: 'Lease Driver' },
        ],
      },
    },
    dealStages: Object.entries(STAGE).map(([role, ID]) => ({ ID, NAME: role })),
    truckCategories: [{ id: 17, name: 'Default pipeline', isDefault: 'Y' }],
    truckStages: STATIC_SCHEMA.activeTruckStageIds.map((ID) => ({ ID, NAME: ID })),
    truckItems: [
      { id: 1, categoryId: 17, stageId: STATIC_SCHEMA.activeTruckStageIds[0] },
      { id: 2, categoryId: 17, stageId: STATIC_SCHEMA.activeTruckStageIds[0] },
    ],
  };
}

function depsFor(c, over = {}) {
  return {
    call: async (method, params) => {
      if (method === 'crm.type.list') return { types: c.types };
      if (method === 'crm.deal.fields') return c.fields;
      if (method === 'crm.item.list') return { items: c.truckItems };
      if (method === 'crm.category.list') {
        return { categories: params.entityTypeId === 2 ? c.categories : c.truckCategories };
      }
      if (method === 'crm.status.list') {
        const entity = params.filter.ENTITY_ID;
        return bitrixStatusRows(entity.startsWith('DEAL_STAGE_') ? c.dealStages : c.truckStages, entity);
      }
      throw new Error(`unexpected ${method}`);
    },
    askStructure: async () => null,
    askSemantics: async () => null,
    getSchemaState: async () => ({ active: null, candidate: null }),
    observeCandidate: async () => ({ status: 'candidate', seenCount: 1, requiresApproval: true }),
    recordInvalid: async () => {},
    ...over,
  };
}

function approvedHistorical(c) {
  const mapping = {
    categoryId: 3,
    truckEntityTypeId: 1040,
    truckCategoryId: 17,
    dealFields: { ...DEAL_FIELDS },
    stageByRole: { ...STAGE },
    fleetByDriverType: { ...FLEET_BY_DRIVER_TYPE },
    activeTruckStageIds: [...STATIC_SCHEMA.activeTruckStageIds],
    evidence: { selectedActiveItems: 2 },
  };
  mapping.catalogSignature = catalogSignature(mapping, {
    ...c,
    dealStages: readAs(c.dealStages, 'DEAL_STAGE_3'),
    truckStages: readAs(c.truckStages, 'DYNAMIC_1040_STAGE_17', 17),
  });
  return {
    mapping, fingerprint: fingerprint(mapping), source: 'catalog_historical', confidence: 100,
  };
}

test('catalog labels use the first non-empty Bitrix spelling', () => {
  assert.equal(labelOf({ name: '', NAME: 'Trucks' }), 'Trucks');
});

test('opaque production truck labels may bootstrap only as a twice-read approval candidate', async () => {
  const c = opaqueTruckCatalog();
  let proposed = null;
  const out = await discoverBitrixSchema(depsFor(c, {
    observeCandidate: async (value) => {
      proposed = value;
      return { status: 'candidate', seenCount: 1, requiresApproval: true };
    },
  }));

  assert.equal(out.writeSafe, false);
  assert.equal(out.source, 'candidate_pending');
  assert.match(out.problem, /administrator approval/);
  assert.equal(proposed.source, 'catalog_historical');
  assert.equal(proposed.anomalous, true);
  assert.equal(proposed.mapping.truckCategoryId, 17);
  assert.deepEqual(proposed.mapping.activeTruckStageIds, STATIC_SCHEMA.activeTruckStageIds);
  assert.equal(proposed.evidence.selectedActiveItems, 2);
});

test('an approved historical mapping is reused automatically while ids and evidence stay valid', async () => {
  const c = opaqueTruckCatalog();
  const active = approvedHistorical(c);
  let proposed = null;
  const out = await discoverBitrixSchema(depsFor(c, {
    getSchemaState: async () => ({ active, candidate: null }),
    askSemantics: async () => { throw new Error('AI must not be needed for a still-valid active mapping'); },
    observeCandidate: async (value) => {
      proposed = value;
      return { status: 'active', seenCount: 2, requiresApproval: false };
    },
  }));

  assert.equal(out.writeSafe, true);
  assert.equal(out.source, 'catalog_historical');
  assert.equal(proposed.anomalous, false);
  assert.equal(proposed.fingerprint, active.fingerprint);
});

test('a changed live truck catalogue is rediscovered instead of silently reusing historical ids', async () => {
  const original = opaqueTruckCatalog();
  const active = approvedHistorical(original);
  const changed = opaqueTruckCatalog();
  changed.truckStages.push({ ID: 'DT1040_17:NEW_STAGE', NAME: 'New stage' });
  let aiCalls = 0;
  let proposed = null;
  const out = await discoverBitrixSchema(depsFor(changed, {
    getSchemaState: async () => ({ active, candidate: null }),
    askSemantics: async () => { aiCalls += 1; return null; },
    observeCandidate: async (value) => {
      proposed = value;
      return { status: 'candidate', seenCount: 1, requiresApproval: true };
    },
  }));
  assert.equal(aiCalls, 1);
  assert.equal(out.writeSafe, false);
  assert.equal(proposed.source, 'catalog_historical');
  assert.notEqual(proposed.fingerprint, active.fingerprint);
  assert.equal(proposed.anomalous, true);
});

test('historical ids never bootstrap another smart process or empty evidence', async () => {
  const wrongProcess = opaqueTruckCatalog();
  wrongProcess.types[0].entityTypeId = 2000;
  wrongProcess.types[0].title = 'Trucks';
  const wrongProcessInvalid = [];
  const wrongProcessOut = await discoverBitrixSchema(depsFor(wrongProcess, {
    recordInvalid: async (value) => wrongProcessInvalid.push(value),
  }));
  assert.equal(wrongProcessOut.writeSafe, false);
  // The consequence, then the cause the historical check found.
  assert.match(wrongProcessInvalid[0].problem, /missing active-truck stages; the Trucks process is not the previously verified 1040/);

  const empty = opaqueTruckCatalog();
  empty.truckItems = [];
  const emptyInvalid = [];
  const emptyOut = await discoverBitrixSchema(depsFor(empty, {
    recordInvalid: async (value) => emptyInvalid.push(value),
  }));
  assert.equal(emptyOut.writeSafe, false);
  assert.match(emptyInvalid[0].problem, /missing active-truck stages; Trucks category 17 holds no current truck items/);
});
