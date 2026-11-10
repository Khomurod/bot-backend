'use strict';

/**
 * Bitrix stage ids read the way Bitrix means them (lib/boardBitrix/stageCodes.js),
 * and the Board ↔ Bitrix schema discovery against a catalogue in the shape the
 * production portal actually answers (November 2026): `crm.status.list` rows
 * with a row NUMBER in `ID` and the stage code in `STATUS_ID`, a Trucks process
 * whose only pipeline is called "Default pipeline", and custom fields whose
 * `title` is only their code. Reading `ID` as the stage blocked the schema in
 * production for good and saved driver stages as "703"; every test here fails
 * on that reading.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeStageRows, stageCodeProblem, dealStagePrefix, truckStagePrefix,
} = require('../lib/boardBitrix/stageCodes');
const { validateMapping, labelOf } = require('../lib/boardBitrix/schema');
const {
  DEAL_FIELDS, FLEET_BY_DRIVER_TYPE, STATIC_SCHEMA, STAGE,
} = require('../lib/boardBitrix/vocabulary');
const { discoverBitrixSchema } = require('../services/boardBitrix/schemaDiscovery');
const { askSemantics } = require('../services/boardBitrix/schemaAi');
const { planStageUpdates } = require('../services/boardBitrix/stageSync');
const { bitrixStatusRows } = require('./helpers/bitrixStatusRows');

const [ROAD, SHOPS, LEAVING] = STATIC_SCHEMA.activeTruckStageIds;
/** The truck counts production read on 10 November 2026 (154 trucks). */
const PRODUCTION_COUNTS = {
  [ROAD]: 104, 'DT1040_17:FAIL': 25, 'DT1040_17:UC_LNR0GS': 8, 'DT1040_17:SUCCESS': 7, 'DT1040_17:CLIENT': 5,
  'DT1040_17:UC_B8F5K5': 1, 'DT1040_17:UC_EDJ1FD': 1, 'DT1040_17:PREPARATION': 1, 'DT1040_17:UC_TU4WEY': 1, 'DT1040_17:UC_BBMB2I': 1,
};

function productionCatalog() {
  const truckStageCodes = [
    'DT1040_17:NEW', 'DT1040_17:PREPARATION', 'DT1040_17:CLIENT', ROAD, SHOPS, LEAVING,
    ...Object.keys(PRODUCTION_COUNTS).filter((code) => /UC_(LNR0GS|B8F5K5|EDJ1FD|TU4WEY|BBMB2I)$/.test(code)),
    'DT1040_17:SUCCESS', 'DT1040_17:FAIL',
  ];
  return {
    categories: [{ id: 3, name: '4. Driver relation', entityTypeId: 2 }],
    types: [{ id: 5, entityTypeId: 1040, title: 'Trucks' }],
    fields: {
      [DEAL_FIELDS.truck]: { type: 'crm', title: DEAL_FIELDS.truck, formLabel: 'Assigned truck', settings: { DYNAMIC_1040: 'Y' } },
      [DEAL_FIELDS.driverType]: {
        type: 'enumeration', title: DEAL_FIELDS.driverType, formLabel: 'Driver type', items: [
          { ID: '361', VALUE: 'Company Driver' }, { ID: '363', VALUE: 'Owner Operator' }, { ID: '395', VALUE: 'Lease Driver' },
        ],
      },
    },
    dealStages: Object.entries(STAGE).map(([role, code]) => ({ ID: code, NAME: role })),
    truckCategories: [{ id: 17, name: 'Default pipeline', isDefault: 'Y', entityTypeId: 1040 }],
    // Labels that are only the stage's code: the historical bootstrap must decide.
    truckStages: truckStageCodes.map((code) => ({ ID: code, NAME: code.split(':')[1] })),
    items: Object.entries(PRODUCTION_COUNTS).flatMap(([stageId, n]) => Array.from({ length: n }, () => ({ categoryId: 17, stageId }))),
  };
}

function deps(c, over = {}) {
  const seen = { invalid: [], proposed: [] };
  return {
    seen,
    deps: {
      call: async (method, params) => {
        if (method === 'crm.type.list') return { types: c.types };
        if (method === 'crm.deal.fields') return c.fields;
        if (method === 'crm.category.list') return { categories: params.entityTypeId === 2 ? c.categories : c.truckCategories };
        if (method === 'crm.status.list') {
          const entity = params.filter.ENTITY_ID;
          return bitrixStatusRows(entity.startsWith('DEAL_STAGE_') ? c.dealStages : c.truckStages, entity);
        }
        if (method === 'crm.item.list') {
          return { items: c.items.slice(params.start, params.start + 50).map((it, i) => ({ id: params.start + i + 1, ...it })) };
        }
        throw new Error(`unexpected ${method}`);
      },
      askStructure: async () => null,
      askSemantics: async () => null,
      getSchemaState: async () => ({ active: null, candidate: null }),
      observeCandidate: async (p) => { seen.proposed.push(p); return { status: 'candidate', seenCount: 1, requiresApproval: true }; },
      recordInvalid: async (r) => { seen.invalid.push(r); },
      ...over,
    },
  };
}

test('a stage row is its STATUS_ID, never its row number; a row without one makes the read incomplete', () => {
  const read = normalizeStageRows([
    { ID: '1087', ENTITY_ID: 'DYNAMIC_1040_STAGE_17', STATUS_ID: ROAD, NAME: 'On the road', SORT: '20', EXTRA: { SEMANTICS: 'process' } },
  ], { categoryId: 17 });
  assert.deepEqual(read, {
    rows: [{ id: ROAD, name: 'On the road', sort: 20, semantics: 'process', __categoryId: 17 }], problem: null,
  });
  assert.match(normalizeStageRows([{ ID: '1087', NAME: 'On the road' }]).problem, /without STATUS_ID/);
});

test('a row number or another pipeline\'s stage is never a stage', () => {
  assert.equal(dealStagePrefix(3), 'C3:');
  assert.equal(dealStagePrefix(0), '');
  assert.equal(truckStagePrefix(1040, 17), 'DT1040_17:');
  assert.match(stageCodeProblem('703', 'C3:'), /row number/);
  assert.match(stageCodeProblem('C9:UC_X', 'C3:'), /not a stage of the selected pipeline/);
  assert.equal(stageCodeProblem('C3:UC_XZ955I', 'C3:'), null);
  assert.equal(stageCodeProblem(ROAD, 'DT1040_17:'), null);
});

test('the mapping saved on 9 November (row numbers for stages) can never validate again', () => {
  const c = productionCatalog();
  const saved = {
    categoryId: 3, truckEntityTypeId: 1040, truckCategoryId: 17,
    dealFields: { truck: DEAL_FIELDS.truck, driverType: DEAL_FIELDS.driverType },
    stageByRole: { HOME: '711', VACATION: '707', SHOP: '1027', WORKING: '703' },
    fleetByDriverType: { ...FLEET_BY_DRIVER_TYPE },
    activeTruckStageIds: ['1087', '987', '989'],
  };
  assert.match(validateMapping(saved, c).reason, /driver stage is invalid: "711" is a Bitrix row number/);
  assert.match(validateMapping({ ...saved, stageByRole: { ...STAGE } }, c).reason, /active-truck stage is invalid: "1087" is a Bitrix row number/);
});

test('production\'s catalogue: the historical truck category and stages become a candidate, every stage a real code', async () => {
  const c = productionCatalog();
  const w = deps(c);
  const out = await discoverBitrixSchema(w.deps);
  assert.equal(out.writeSafe, false, 'a candidate never writes');
  assert.equal(w.seen.invalid.length, 0, w.seen.invalid[0]?.problem);
  const [proposed] = w.seen.proposed;
  assert.equal(proposed.source, 'catalog_historical');
  assert.equal(proposed.mapping.truckCategoryId, 17);
  assert.deepEqual(proposed.mapping.activeTruckStageIds, [ROAD, SHOPS, LEAVING]);
  assert.deepEqual(proposed.mapping.stageByRole, { ...STAGE }, 'driver stages are C3:… codes, never row numbers');
  assert.equal(proposed.evidence.selectedActiveItems, 104);
  assert.equal(proposed.evidence.selectedCategoryItems, 154);
  assert.deepEqual(proposed.evidence.populatedStages[0], { label: 'UC_90RJVZ', category: 'Default pipeline', itemCount: 104 },
    'the counted stage is found in the catalogue — its name and its pipeline, not a bare code');
  assert.deepEqual(proposed.evidence.historicalStages.map((s) => [s.code, s.present, s.itemCount]),
    [[ROAD, true, 104], [SHOPS, true, 0], [LEAVING, true, 0]]);
});

test('a previously verified stage Bitrix no longer lists blocks the schema and is named', async () => {
  const c = productionCatalog();
  c.truckStages = c.truckStages.filter((row) => row.ID !== LEAVING);
  const w = deps(c);
  const out = await discoverBitrixSchema(w.deps);
  assert.equal(out.writeSafe, false);
  assert.equal(out.comparisonSafe, false);
  assert.equal(w.seen.proposed.length, 0);
  assert.match(w.seen.invalid[0].problem, new RegExp(`Bitrix no longer lists the previously verified truck stage\\(s\\) ${LEAVING}`));
  assert.deepEqual(w.seen.invalid[0].evidence.historicalStages.find((s) => s.code === LEAVING), {
    code: LEAVING, label: null, present: false, itemCount: 0,
  });
});

test('a stage row without STATUS_ID stops discovery: nothing is compared from a half-read catalogue', async () => {
  const c = productionCatalog();
  const w = deps(c);
  const call = w.deps.call;
  w.deps.call = async (method, params) => {
    const out = await call(method, params);
    if (method === 'crm.status.list' && params.filter.ENTITY_ID.startsWith('DYNAMIC_')) {
      return out.map(({ STATUS_ID, ...row }, i) => (i === 0 ? row : { STATUS_ID, ...row }));
    }
    return out;
  };
  const out = await discoverBitrixSchema(w.deps);
  assert.equal(out.comparisonSafe, false);
  assert.match(w.seen.invalid[0].problem, /stage row\(s\) without STATUS_ID/);
});

test('the stale row-number mapping is never reused, even as the active schema', async () => {
  const c = productionCatalog();
  const stale = {
    source: 'ai_validated', confidence: 90, fingerprint: 'stale',
    mapping: {
      categoryId: 3, truckEntityTypeId: 1040, truckCategoryId: 17,
      dealFields: { truck: DEAL_FIELDS.truck, driverType: DEAL_FIELDS.driverType },
      stageByRole: { HOME: '711', VACATION: '707', SHOP: '1027', WORKING: '703' },
      fleetByDriverType: { ...FLEET_BY_DRIVER_TYPE },
      activeTruckStageIds: ['1087', '987', '989'],
    },
  };
  const w = deps(c, { getSchemaState: async () => ({ active: stale, candidate: null }) });
  await discoverBitrixSchema(w.deps);
  const [proposed] = w.seen.proposed;
  assert.equal(proposed.source, 'catalog_historical');
  assert.equal(proposed.activeValid, false);
  assert.ok(Object.values(proposed.mapping.stageByRole).every((id) => id.startsWith('C3:')));
});

test('the model is shown stage codes with their real truck counts, and fields by the words people read', async () => {
  const c = productionCatalog();
  let request = null;
  const truckStages = normalizeStageRows(bitrixStatusRows(c.truckStages, 'DYNAMIC_1040_STAGE_17'), { categoryId: 17 }).rows;
  const dealStages = normalizeStageRows(bitrixStatusRows(c.dealStages, 'DEAL_STAGE_3')).rows;
  await askSemantics({
    fields: c.fields, dealStages, truckCategories: c.truckCategories, truckStages,
    evidence: { totalItems: 154, categoryCounts: { 17: 154 }, stageCounts: PRODUCTION_COUNTS },
  }, { runCapability: async (req) => { request = JSON.parse(req.userText); return { uncertain: true }; } });
  const road = request.truck_stages.find((s) => s.id === ROAD);
  assert.equal(road.item_count, 104, 'the populated stage is not shown as empty');
  assert.ok(request.truck_stages.every((s) => !/^\d+$/.test(s.id)), 'no row number reaches the model');
  assert.ok(request.driver_stages.every((s) => s.id.startsWith('C3:')));
  assert.equal(request.deal_fields.find((f) => f.id === DEAL_FIELDS.truck).label, 'Assigned truck');
  assert.equal(labelOf({ id: 'UF_CRM_X', title: 'UF_CRM_X', formLabel: 'Driver type' }), 'Driver type');
});

test('a sync plan never targets a row number, whatever an old question carries', () => {
  const schema = { stageByRole: { ...STAGE }, writeSafe: true };
  const now = Date.parse('2026-11-10T18:00:00Z');
  const plan = planStageUpdates([{
    kind: 'status_differs', key: 'deal:321',
    board: { status: 'HOME', statusChangedAt: '2026-11-10T10:00:00Z', rowKey: '01|john' },
    deal: { id: 321, stageId: STAGE.WORKING }, expectedStageId: '711',
  }], schema, { now });
  assert.equal(plan.candidates.length, 0);
});
