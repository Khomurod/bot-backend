'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { STATIC_SCHEMA } = require('../lib/boardBitrix/vocabulary');
const { complete, resolveSemantics, validateMapping } = require('../lib/boardBitrix/schema');
const { assessEvidence, buildTruckEvidence } = require('../lib/boardBitrix/schemaEvidence');
const { decideCandidate } = require('../lib/boardBitrix/schemaCandidate');
const { askSemantics, fieldPromptRows, semanticsValidator } = require('../services/boardBitrix/schemaAi');
const { discoverBitrixSchema } = require('../services/boardBitrix/schemaDiscovery');
const { planStageUpdates, runStageSync } = require('../services/boardBitrix/stageSync');
const { bitrixStatusRows } = require('./helpers/bitrixStatusRows');

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
      { ID: 'C9:H', NAME: renamed ? 'Residence' : 'HOME' },
      { ID: 'C9:V', NAME: renamed ? 'Time Away' : 'VACATION' },
      { ID: 'C9:S', NAME: renamed ? 'Repair Bay' : 'SHOP' },
      { ID: 'C9:W', NAME: renamed ? 'Rolling' : 'WORKING' },
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
          const entity = params.filter.ENTITY_ID;
          return bitrixStatusRows(entity.startsWith('DEAL_STAGE_') ? c.dealStages : c.truckStages, entity);
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
  assert.deepEqual(out.stageByRole, { HOME: 'C9:H', VACATION: 'C9:V', SHOP: 'C9:S', WORKING: 'C9:W' });
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
    stages: { HOME: 'C9:H', VACATION: 'C9:V', SHOP: 'C9:S', WORKING: 'C9:W' },
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
    askSemantics: async () => ({ ...aiSemantics, stages: { ...aiSemantics.stages, WORKING: 'C9:MADE_UP' } }),
  });
  const refused = await discoverBitrixSchema(bad.deps);
  assert.equal(refused.writeSafe, false);
  assert.equal(refused.source, 'static_fallback');
  assert.match(refused.problem, /stage was not returned/);
  assert.equal(bad.recorded.at(-1).invalid, true);
  assert.match(bad.recorded.at(-1).problem, /stage was not returned/);
});

test('AI routing rejects an overconfident empty truck-stage answer and can ask another model', async () => {
  const c = catalog({ renamed: true });
  c.truckStages.push({ ID: 'DT2000_7:EMPTY', NAME: 'Archive' });
  const truckStages = c.truckStages.map((row) => ({ ...row, __categoryId: 7 }));
  const evidence = buildTruckEvidence(c.truckItems);
  const good = {
    understood: true, confidence: 95,
    deal_fields: { truck: 'UF_NEW_TRUCK', driver_type: 'UF_NEW_TYPE' },
    stages: { HOME: 'C9:H', VACATION: 'C9:V', SHOP: 'C9:S', WORKING: 'C9:W' },
    truck_category_id: '7', active_truck_stage_ids: ['DT2000_7:ROAD'],
  };
  const empty = { ...good, active_truck_stage_ids: ['DT2000_7:EMPTY'], confidence: 99 };
  const sameField = { ...good, deal_fields: {
    truck: 'UF_NEW_TRUCK', driver_type: 'UF_NEW_TRUCK',
  } };
  const validate = semanticsValidator({
    fields: c.fields, dealStages: c.dealStages, truckCategories: c.truckCategories,
    truckStages, evidence,
  });
  assert.match(validate('', empty).message, /zero current items/);
  assert.match(validate('', sameField).message, /two distinct deal fields/);
  assert.equal(validate('', good), true);
  assert.equal(validate('', { understood: false, confidence: 99 }), true,
    'an honest refusal is valid output so the escalation layer can ask a stronger model');

  let routed = false;
  const answer = await askSemantics({
    fields: c.fields, dealStages: c.dealStages, truckCategories: c.truckCategories,
    truckStages, evidence,
  }, { runCapability: async (args) => {
    routed = true;
    assert.match(args.validate('', empty).message, /zero current items/);
    return { parsed: good, uncertain: false };
  } });
  assert.equal(routed, true);
  assert.deepEqual(answer.active_truck_stage_ids, ['DT2000_7:ROAD']);
});

test('AI sees every bounded deal field plus safe relation and enum schema metadata', async () => {
  const fields = Object.fromEntries(Array.from({ length: 180 }, (_, i) => [
    `UF_OTHER_${i}`, { title: `Other field ${i}`, type: 'string' },
  ]));
  fields.UF_RENAMED_TRUCK = {
    name: '', title: 'Asset seat', type: 'crm', settings: { DYNAMIC_2000: 'Y' },
  };
  fields.UF_RENAMED_TYPE = {
    title: 'Employment class', type: 'enumeration',
    items: [{ VALUE: 'Company Driver' }, { VALUE: 'Owner Operator' },
      { VALUE: 'Lease Driver' }, { VALUE: 'Private custom choice' }],
  };
  const safe = fieldPromptRows(fields);
  assert.equal(safe.length, 182);
  assert.equal(safe.find((row) => row.id === 'UF_RENAMED_TRUCK').label, 'Asset seat');
  assert.deepEqual(safe.find((row) => row.id === 'UF_RENAMED_TRUCK').relation_targets, ['DYNAMIC_2000']);
  assert.deepEqual(safe.find((row) => row.id === 'UF_RENAMED_TYPE').enum_labels,
    ['Company Driver', 'Owner Operator', 'Lease Driver']);

  const c = catalog({ renamed: true });
  const good = {
    understood: true, confidence: 96,
    deal_fields: { truck: 'UF_RENAMED_TRUCK', driver_type: 'UF_RENAMED_TYPE' },
    stages: { HOME: 'C9:H', VACATION: 'C9:V', SHOP: 'C9:S', WORKING: 'C9:W' },
    truck_category_id: '7', active_truck_stage_ids: ['DT2000_7:ROAD'],
  };
  await askSemantics({
    fields, dealStages: c.dealStages, truckCategories: c.truckCategories,
    truckStages: c.truckStages.map((row) => ({ ...row, __categoryId: 7 })),
    evidence: buildTruckEvidence(c.truckItems),
  }, { runCapability: async (args) => {
    const prompt = JSON.parse(args.userText);
    assert.ok(prompt.deal_fields.some((row) => row.id === 'UF_RENAMED_TRUCK'));
    assert.ok(prompt.deal_fields.some((row) => row.id === 'UF_RENAMED_TYPE'));
    return { parsed: good, uncertain: false };
  } });
  assert.throws(() => fieldPromptRows(Array.from({ length: 501 }, (_, id) => ({ id }))), /incomplete/);
});

test('safe field metadata resolves renamed deal fields before AI has to guess', () => {
  const c = catalog();
  const fields = {
    UF_ASSET: { title: 'Asset seat', type: 'crm', settings: { DYNAMIC_2000: 'Y' } },
    UF_CLASS: { title: 'Employment class', type: 'enumeration', items: [
      { ID: '501', VALUE: 'Company Driver' }, { ID: '502', VALUE: 'Owner Operator' },
      { ID: '503', VALUE: 'Lease Driver' },
    ] },
  };
  const out = resolveSemantics({ ...c, fields, truckEntityTypeId: 2000 });
  assert.deepEqual(out.dealFields, { truck: 'UF_ASSET', driverType: 'UF_CLASS' });
  assert.deepEqual(out.fleetByDriverType, {
    501: 'company', 502: 'owner_operator', 503: 'lease',
  });
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
  assert.match(assessEvidence(wrong, buildTruckEvidence([])).reason, /no current truck items for schema evidence/);
});

test('an invalid AI selection records only safe populated-stage diagnostics', async () => {
  const c = catalog({ renamed: true });
  c.truckStages.push({ ID: 'DT2000_7:EMPTY', NAME: 'Archive' });
  const aiStructure = { understood: true, category_id: '9', truck_entity_type_id: '2000', confidence: 93 };
  const w = discoveryDeps(c, {
    askStructure: async () => aiStructure,
    askSemantics: async () => ({
      understood: true, confidence: 99,
      deal_fields: { truck: 'UF_NEW_TRUCK', driver_type: 'UF_NEW_TYPE' },
      stages: { HOME: 'C9:H', VACATION: 'C9:V', SHOP: 'C9:S', WORKING: 'C9:W' },
      truck_category_id: '7', active_truck_stage_ids: ['DT2000_7:EMPTY'],
    }),
  });
  const out = await discoverBitrixSchema(w.deps);
  assert.equal(out.comparisonSafe, false);
  const invalid = w.recorded.at(-1);
  assert.equal(invalid.invalid, true);
  assert.deepEqual(invalid.evidence.populatedStages, [
    { label: 'Rolling Asset', category: 'Primary Flow', itemCount: 1 },
  ]);
  assert.ok(!JSON.stringify(invalid.evidence).includes('81'), 'truck item ids are never diagnostic data');
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
    stageByRole: { HOME: 'C9:H', VACATION: 'C9:V', SHOP: 'C9:S', WORKING: 'C9:W' },
    activeTruckStageIds: ['DT2000_7:ROAD'],
  };
  assert.deepEqual(validateMapping(mapping, c), { ok: true });
  assert.match(validateMapping({ ...mapping, categoryId: 999 }, c).reason, /pipeline/);
  assert.match(validateMapping({ ...mapping, dealFields: {
    truck: 'UF_NEW_TRUCK', driverType: 'UF_NEW_TRUCK',
  } }, c).reason, /two different Bitrix fields/);
  assert.match(validateMapping({ ...mapping, stageByRole: { ...mapping.stageByRole, WORKING: 'C9:H' } }, c).reason, /different stages/);
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
      id: 321, title: 'ALAN BROWN', stageId: 'C9:W',
      fleetType: 'owner_operator', truckNumber: '001',
    },
    expectedStageId: 'C9:H', ...over,
  };
}

const schema = {
  categoryId: 9,
  stageByRole: { HOME: 'C9:H', VACATION: 'C9:V', SHOP: 'C9:S', WORKING: 'C9:W' },
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
          return { ID: '321', CATEGORY_ID: '9', CLOSED: 'N', STAGE_ID: reads === 1 ? 'C9:W' : 'C9:H' };
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
    params: { id: 321, fields: { STAGE_ID: 'C9:H' }, params: { REGISTER_SONET_EVENT: 'Y' } },
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
        return { CATEGORY_ID: '9', CLOSED: 'N', STAGE_ID: 'C9:S' };
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
        return { CATEGORY_ID: '9', CLOSED: 'N', STAGE_ID: 'C9:W' };
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
        return { CATEGORY_ID: '9', CLOSED: 'N', STAGE_ID: 'C9:W' };
      },
    },
  });
  assert.equal(checks, 2);
  assert.equal(updates, 0);
  assert.equal(out.failed, 1);
  assert.match(out.errors[0], /switched off/);
});

test('a status time handed over as a Date keeps its milliseconds (the 11 November 2026 bug)', () => {
  const changedAt = new Date(NOW - 60 * 60000 + 647);
  const plan = planStageUpdates([mismatch({ board: { ...mismatch().board, statusChangedAt: changedAt } })], schema, { now: NOW });
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].statusChangedAt, changedAt.toISOString(), 'not rounded down to the second');
  assert.match(plan.candidates[0].statusChangedAt, /\.\d{3}Z$/);
});
