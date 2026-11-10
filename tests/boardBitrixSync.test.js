'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { STATIC_SCHEMA } = require('../lib/boardBitrix/vocabulary');
const { complete, validateMapping } = require('../lib/boardBitrix/schema');
const { assessEvidence, buildTruckEvidence } = require('../lib/boardBitrix/schemaEvidence');
const { decideCandidate } = require('../lib/boardBitrix/schemaCandidate');
const { discoverBitrixSchema } = require('../services/boardBitrix/schemaDiscovery');
const { planStageUpdates, runStageSync } = require('../services/boardBitrix/stageSync');

const NOW = Date.parse('2026-11-09T18:00:00Z');
const ago = (minutes) => new Date(NOW - minutes * 60000).toISOString();

function catalog({ renamed = false } = {}) {
  return {
    categories: [{ id: 9, name: renamed ? 'Drivers 2027' : '4. DRIVER RELATION' }],
    types: [{ entityTypeId: 2000, title: renamed ? 'Fleet Assets' : 'Trucks' }],
    fields: {
      UF_NEW_TRUCK: { title: renamed ? 'Vehicle Seat' : 'Assigned Truck' },
      UF_NEW_TYPE: {
        title: renamed ? 'Employment Class' : 'Driver Type',
        items: [
          { ID: '501', VALUE: 'Company Driver' },
          { ID: '502', VALUE: 'Owner Operator' },
          { ID: '503', VALUE: 'Lease Driver' },
        ],
      },
    },
    dealStages: [
      { ID: 'D9:H', NAME: renamed ? 'Residence' : 'HOME' },
      { ID: 'D9:V', NAME: renamed ? 'Time Away' : 'VACATION' },
      { ID: 'D9:S', NAME: renamed ? 'Repair Bay' : 'SHOP' },
      { ID: 'D9:W', NAME: renamed ? 'Rolling' : 'WORKING' },
    ],
    truckCategories: [{ id: 7, name: renamed ? 'Primary Flow' : 'Trucks' }],
    truckStages: [{ ID: 'DT2000_7:ROAD', NAME: renamed ? 'Rolling Asset' : 'On the road' }],
    truckItems: [{ id: 81, categoryId: 7, stageId: 'DT2000_7:ROAD' }],
  };
}

function discoveryDeps(c, over = {}) {
  const recorded = [];
  const calls = [];
  let currentCandidate = null;
  return {
    recorded,
    calls,
    deps: {
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === 'crm.type.list') return { types: c.types };
        if (method === 'crm.deal.fields') return c.fields;
        if (method === 'crm.item.list') return { items: c.truckItems };
        if (method === 'crm.category.list') {
          return { categories: params.entityTypeId === 2 ? c.categories : c.truckCategories };
        }
        if (method === 'crm.status.list') {
          return params.filter.ENTITY_ID.startsWith('DEAL_STAGE_') ? c.dealStages : c.truckStages;
        }
        throw new Error(`unexpected ${method}`);
      },
      askStructure: async () => null,
      askSemantics: async () => null,
      getSchemaState: async () => ({ active: null, candidate: currentCandidate }),
      observeCandidate: async (s) => {
        recorded.push(s);
        currentCandidate = { state: 'candidate', fingerprint: s.fingerprint, seenCount: 1 };
        return { status: 'active', seenCount: 2, requiresApproval: false };
      },
      recordInvalid: async (s) => { recorded.push({ invalid: true, ...s }); },
      ...over,
    },
  };
}

test('exact live Bitrix labels produce a write-safe dynamic schema without AI', async () => {
  const c = catalog();
  const w = discoveryDeps(c, {
    askStructure: async () => { throw new Error('AI should not be asked'); },
    askSemantics: async () => { throw new Error('AI should not be asked'); },
  });
  const out = await discoverBitrixSchema(w.deps);
  assert.equal(out.writeSafe, true);
  assert.equal(out.source, 'catalog_exact');
  assert.equal(out.categoryId, 9);
  assert.equal(out.truckEntityTypeId, 2000);
  assert.deepEqual(out.stageByRole, { HOME: 'D9:H', VACATION: 'D9:V', SHOP: 'D9:S', WORKING: 'D9:W' });
  assert.deepEqual(out.fleetByDriverType, {
    501: 'company', 502: 'owner_operator', 503: 'lease',
  });
  assert.deepEqual(out.activeTruckStageIds, ['DT2000_7:ROAD']);
  assert.equal(w.recorded.length, 1);
  assert.equal(w.recorded[0].evidence.selectedActiveItems, 1);
  assert.deepEqual(w.calls.find((entry) => entry.method === 'crm.item.list').params.select,
    ['id', 'categoryId', 'stageId'], 'schema evidence never reads a truck title or driver field');
});

test('the first valid schema observation is pending and cannot affect comparison', async () => {
  const c = catalog();
  const w = discoveryDeps(c, {
    observeCandidate: async () => ({ status: 'candidate', seenCount: 1, requiresApproval: false }),
  });
  const out = await discoverBitrixSchema(w.deps);
  assert.equal(out.source, 'candidate_pending');
  assert.equal(out.comparisonSafe, false);
  assert.equal(out.writeSafe, false);
  assert.match(out.problem, /seen 1\/2/);
});

test('renamed labels may be mapped by AI, but only to ids from the live catalogue', async () => {
  const c = catalog({ renamed: true });
  const aiStructure = { understood: true, category_id: '9', truck_entity_type_id: '2000', confidence: 93 };
  const aiSemantics = {
    understood: true,
    deal_fields: { truck: 'UF_NEW_TRUCK', driver_type: 'UF_NEW_TYPE' },
    stages: { HOME: 'D9:H', VACATION: 'D9:V', SHOP: 'D9:S', WORKING: 'D9:W' },
    truck_category_id: '7', active_truck_stage_ids: ['DT2000_7:ROAD'], confidence: 91,
  };
  const w = discoveryDeps(c, {
    askStructure: async () => aiStructure,
    askSemantics: async () => aiSemantics,
  });
  const out = await discoverBitrixSchema(w.deps);
  assert.equal(out.writeSafe, true);
  assert.equal(out.source, 'ai_validated');
  assert.equal(out.confidence, 91);

  const bad = discoveryDeps(c, {
    askStructure: async () => aiStructure,
    askSemantics: async () => ({ ...aiSemantics, stages: { ...aiSemantics.stages, WORKING: 'MADE_UP' } }),
  });
  const refused = await discoverBitrixSchema(bad.deps);
  assert.equal(refused.writeSafe, false);
  assert.equal(refused.source, 'static_fallback');
  assert.match(refused.problem, /stage was not returned/);
  assert.equal(bad.recorded.at(-1).invalid, true);
  assert.match(bad.recorded.at(-1).problem, /stage was not returned/);
});

test('an incomplete or low-confidence discovery falls back to reads and cannot be live', async () => {
  const c = catalog({ renamed: true });
  const w = discoveryDeps(c, {
    askStructure: async () => ({ understood: true, category_id: '9', truck_entity_type_id: '2000', confidence: 60 }),
  });
  const out = await discoverBitrixSchema(w.deps);
  assert.equal(out.writeSafe, false);
  assert.equal(out.categoryId, STATIC_SCHEMA.categoryId);
  assert.equal(complete(out), true, 'the static map remains usable for the old read-only check');
  assert.equal(w.recorded.length, 1);
  assert.equal(w.recorded[0].invalid, true);
  assert.match(w.recorded[0].problem, /ambiguous/);
});

test('truck evidence refuses the production failure shape: populated category, zero selected active stages', () => {
  const evidence = buildTruckEvidence([
    { categoryId: 7, stageId: 'DT2000_7:ROAD' },
    { categoryId: 7, stageId: 'DT2000_7:ROAD' },
  ]);
  const wrong = {
    truckCategoryId: 7,
    activeTruckStageIds: ['DT2000_7:EMPTY'],
  };
  const out = assessEvidence(wrong, evidence, { baselineActiveCount: 2 });
  assert.equal(out.ok, false);
  assert.equal(out.counts.activeItems, 0);
  assert.match(out.reason, /no current truck items/);
});

test('a schema candidate must repeat; structural or count drift needs approval', () => {
  const proposed = { fingerprint: 'new', mapping: { categoryId: 3, truckEntityTypeId: 1040,
    truckCategoryId: 17, dealFields: { truck: 'T', driverType: 'D' } } };
  const first = decideCandidate({ proposed });
  assert.equal(first.seenCount, 1);
  assert.equal(first.promote, false);
  const second = decideCandidate({ proposed, current: { state: 'candidate', fingerprint: 'new', seenCount: 1 } });
  assert.equal(second.promote, true);
  const active = { fingerprint: 'old', mapping: { ...proposed.mapping, truckCategoryId: 99 } };
  const structural = decideCandidate({ active, activeValid: true, proposed,
    current: { state: 'candidate', fingerprint: 'new', seenCount: 1 } });
  assert.equal(structural.seenCount, 2);
  assert.equal(structural.requiresApproval, true);
  assert.equal(structural.promote, false);
  assert.equal(decideCandidate({ active, activeValid: false, activeProven: true, proposed })
    .requiresApproval, true, 'a previously proven structure stays protected after its ids disappear');
  assert.equal(decideCandidate({ proposed, anomalous: true }).requiresApproval, true);
});

test('the mapping validator rejects ids and duplicate role stages a model invented', () => {
  const c = catalog();
  const mapping = {
    categoryId: 9, truckEntityTypeId: 2000, truckCategoryId: 7,
    dealFields: { truck: 'UF_NEW_TRUCK', driverType: 'UF_NEW_TYPE' },
    stageByRole: { HOME: 'D9:H', VACATION: 'D9:V', SHOP: 'D9:S', WORKING: 'D9:W' },
    activeTruckStageIds: ['DT2000_7:ROAD'],
  };
  assert.deepEqual(validateMapping(mapping, c), { ok: true });
  assert.match(validateMapping({ ...mapping, categoryId: 999 }, c).reason, /pipeline/);
  assert.match(validateMapping({ ...mapping, stageByRole: { ...mapping.stageByRole, WORKING: 'D9:H' } }, c).reason, /different stages/);
  const wrongCategory = { ...c, truckStages: c.truckStages.map((row) => ({ ...row, __categoryId: 8 })) };
  assert.match(validateMapping(mapping, wrongCategory).reason, /another Trucks category/);
});

function mismatch(over = {}) {
  return {
    kind: 'status_differs', key: 'status_differs:deal:321',
    board: {
      rowKey: 'owner_operator:001:alan-brown', status: 'HOME', statusChangedAt: ago(60),
      name: 'ALAN BROWN', fleetType: 'owner_operator', truck: '001',
    },
    deal: {
      id: 321, title: 'ALAN BROWN', stageId: 'D9:W',
      fleetType: 'owner_operator', truckNumber: '001',
    },
    expectedStageId: 'D9:H', ...over,
  };
}

const schema = {
  categoryId: 9,
  stageByRole: { HOME: 'D9:H', VACATION: 'D9:V', SHOP: 'D9:S', WORKING: 'D9:W' },
  fingerprint: 'abc', writeSafe: true,
};

test('a Board status must settle, and a mass change stops the whole pass', () => {
  assert.equal(planStageUpdates([mismatch({ board: {
    ...mismatch().board, statusChangedAt: ago(5),
  } })], schema, { now: NOW }).settling, 1);
  const many = Array.from({ length: 4 }, (_, i) => mismatch({
    key: `status_differs:deal:${i + 1}`,
    deal: { ...mismatch().deal, id: i + 1 },
  }));
  const plan = planStageUpdates(many, schema, { now: NOW, maxUpdates: 3 });
  assert.equal(plan.candidates.length, 0);
  assert.match(plan.blocked, /safety limit/);
});

test('a fuzzy name or non-exact truck remains a question and can never enter the write plan', () => {
  const fuzzy = mismatch({ deal: { ...mismatch().deal, title: 'ALAN BROWM' } });
  const formattedTruck = mismatch({
    key: 'status_differs:deal:322',
    deal: { ...mismatch().deal, id: 322, truckNumber: '1' },
  });
  const plan = planStageUpdates([fuzzy, formattedTruck], schema, { now: NOW });
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.unsafeIdentity, 2);
});

test('dry run records the transition and never calls Bitrix', async () => {
  const plans = [];
  const out = await runStageSync({
    discrepancies: [mismatch()], schema, mode: 'dry_run',
    deps: {
      now: () => NOW,
      recordPlan: async (p) => { plans.push(p); return true; },
      call: async () => { throw new Error('must not call Bitrix'); },
    },
  });
  assert.equal(out.planned, 1);
  assert.equal(plans[0].dealId, 321);
});

test('live sync claims, re-reads, writes only STAGE_ID, verifies and resolves that discrepancy', async () => {
  const calls = [];
  const finished = [];
  let reads = 0;
  const out = await runStageSync({
    discrepancies: [mismatch()], schema, mode: 'live',
    deps: {
      now: () => NOW,
      isLiveEnabled: async () => true,
      claim: async () => 7,
      finish: async (...args) => { finished.push(args); },
      confirmBoardStatus: async (item) => item.rowKey === mismatch().board.rowKey,
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === 'crm.deal.get') {
          reads += 1;
          return { ID: '321', CATEGORY_ID: '9', CLOSED: 'N', STAGE_ID: reads === 1 ? 'D9:W' : 'D9:H' };
        }
        if (method === 'crm.deal.update') return true;
        throw new Error('unexpected call');
      },
    },
  });
  assert.equal(out.applied, 1);
  assert.deepEqual(out.resolvedKeys, ['status_differs:deal:321']);
  assert.deepEqual(calls[1], {
    method: 'crm.deal.update',
    params: { id: 321, fields: { STAGE_ID: 'D9:H' }, params: { REGISTER_SONET_EVENT: 'Y' } },
  });
  assert.deepEqual(finished, [[7, 'applied']]);
});

test('live sync never overwrites a deal moved after comparison, and fallback schema blocks every write', async () => {
  let updates = 0;
  const changed = await runStageSync({
    discrepancies: [mismatch()], schema, mode: 'live',
    deps: {
      now: () => NOW,
      isLiveEnabled: async () => true,
      claim: async () => 8,
      finish: async () => {},
      confirmBoardStatus: async () => true,
      call: async (method) => {
        if (method === 'crm.deal.update') updates += 1;
        return { CATEGORY_ID: '9', CLOSED: 'N', STAGE_ID: 'D9:S' };
      },
    },
  });
  assert.equal(changed.failed, 1);
  assert.equal(updates, 0);

  const blocked = await runStageSync({
    discrepancies: [mismatch()], schema: { ...schema, writeSafe: false, problem: 'schema drift' }, mode: 'live',
    deps: { now: () => NOW },
  });
  assert.match(blocked.blocked, /schema drift/);
});

test('live sync fails closed when the Board event changed after comparison', async () => {
  let updates = 0;
  const out = await runStageSync({
    discrepancies: [mismatch()], schema, mode: 'live',
    deps: {
      now: () => NOW,
      isLiveEnabled: async () => true,
      claim: async () => 9,
      finish: async () => {},
      confirmBoardStatus: async () => false,
      call: async (method) => {
        if (method === 'crm.deal.update') updates += 1;
        return { CATEGORY_ID: '9', CLOSED: 'N', STAGE_ID: 'D9:W' };
      },
    },
  });
  assert.equal(out.failed, 1);
  assert.equal(updates, 0);
  assert.match(out.errors[0], /Board status changed/);
});

test('live sync re-reads its kill switch immediately before the Bitrix mutation', async () => {
  let checks = 0;
  let updates = 0;
  const out = await runStageSync({
    discrepancies: [mismatch()], schema, mode: 'live',
    deps: {
      now: () => NOW,
      isLiveEnabled: async () => { checks += 1; return checks === 1; },
      claim: async () => 10,
      finish: async () => {},
      confirmBoardStatus: async () => true,
      call: async (method) => {
        if (method === 'crm.deal.update') updates += 1;
        return { CATEGORY_ID: '9', CLOSED: 'N', STAGE_ID: 'D9:W' };
      },
    },
  });
  assert.equal(checks, 2);
  assert.equal(updates, 0);
  assert.equal(out.failed, 1);
  assert.match(out.errors[0], /switched off/);
});
