'use strict';

/**
 * Discover the current Bitrix schema from catalogue labels plus aggregate
 * truck counts. A model may propose ids; catalogue/evidence checks and a
 * durable two-pass candidate decide whether the mapping can become active.
 */
const { STATIC_SCHEMA } = require('../../lib/boardBitrix/vocabulary');
const {
  resolveStructure, resolveSemantics, resolveHistoricalTruck, activeSchemaSource, catalogSignature,
  complete, validateMapping, fingerprint,
} = require('../../lib/boardBitrix/schema');
const {
  buildTruckEvidence, countSelected, assessEvidence, summarizeEvidence, describeMapping,
} = require('../../lib/boardBitrix/schemaEvidence');
const { askStructure, askSemantics } = require('./schemaAi');

const MIN_AI_CONFIDENCE = 85;
const PAGE_SIZE = 50;
const MAX_ITEM_PAGES = 40;
const MAX_TRUCK_CATEGORIES = 20;

function defaultDeps() {
  /* eslint-disable global-require */
  const schemaStore = require('../../database/boardBitrixSchema');
  return {
    call: require('../bitrix24DealStages').callBitrix,
    askStructure,
    askSemantics,
    getSchemaState: schemaStore.getSchemaState,
    observeCandidate: schemaStore.observeCandidate,
    recordInvalid: schemaStore.recordInvalid,
  };
  /* eslint-enable global-require */
}

function rows(result, key) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.[key]) ? result[key] : [];
}

function cleanProblem(problem) {
  return String(problem || 'the live Bitrix schema could not be discovered')
    .replace(/\s+/g, ' ').trim().slice(0, 240);
}

function fallback(problem, source = 'static_fallback') {
  return {
    ...STATIC_SCHEMA,
    dealFields: { ...STATIC_SCHEMA.dealFields },
    stageByRole: { ...STATIC_SCHEMA.stageByRole },
    fleetByDriverType: { ...STATIC_SCHEMA.fleetByDriverType },
    activeTruckStageIds: [...STATIC_SCHEMA.activeTruckStageIds],
    source,
    problem: cleanProblem(problem),
    fingerprint: fingerprint(STATIC_SCHEMA),
    comparisonSafe: false,
    writeSafe: false,
  };
}

async function recordFallback(problem, deps, evidence = {}) {
  const out = fallback(problem);
  if (typeof deps.recordInvalid === 'function') {
    await Promise.resolve(deps.recordInvalid({ problem: out.problem, evidence })).catch(() => {});
  }
  return out;
}

function structureFromAi(answer, categories, types) {
  if (!answer || Number(answer.confidence) < MIN_AI_CONFIDENCE) return null;
  const categoryId = Number(answer.category_id);
  const truckEntityTypeId = Number(answer.truck_entity_type_id);
  const categoryIds = new Set(categories.map((r) => Number(r.id ?? r.ID)));
  const typeIds = new Set(types.map((r) => Number(r.entityTypeId ?? r.ENTITY_TYPE_ID ?? r.id ?? r.ID)));
  if (!categoryIds.has(categoryId) || !typeIds.has(truckEntityTypeId)) return null;
  return { categoryId, truckEntityTypeId, confidence: Number(answer.confidence) };
}

function mergeAiSemantics(base, answer) {
  if (!answer || Number(answer.confidence) < MIN_AI_CONFIDENCE) return base;
  return {
    ...base,
    dealFields: {
      truck: String(answer.deal_fields?.truck || base.dealFields?.truck || ''),
      driverType: String(answer.deal_fields?.driver_type || base.dealFields?.driverType || ''),
    },
    stageByRole: {
      HOME: String(answer.stages?.HOME || base.stageByRole?.HOME || ''),
      VACATION: String(answer.stages?.VACATION || base.stageByRole?.VACATION || ''),
      SHOP: String(answer.stages?.SHOP || base.stageByRole?.SHOP || ''),
      WORKING: String(answer.stages?.WORKING || base.stageByRole?.WORKING || ''),
    },
    truckCategoryId: answer.truck_category_id == null
      ? base.truckCategoryId : Number(answer.truck_category_id),
    activeTruckStageIds: Array.isArray(answer.active_truck_stage_ids)
      ? answer.active_truck_stage_ids.map(String) : base.activeTruckStageIds,
    confidence: Number(answer.confidence),
  };
}

async function readTruckEvidence(call, entityTypeId) {
  const items = [];
  for (let page = 0; page < MAX_ITEM_PAGES; page += 1) {
    // Aggregate evidence only: no title, assigned driver, or other item field.
    // eslint-disable-next-line no-await-in-loop
    const result = await call('crm.item.list', {
      entityTypeId, select: ['id', 'categoryId', 'stageId'],
      order: { id: 'ASC' }, start: page * PAGE_SIZE,
    });
    const batch = rows(result, 'items');
    items.push(...batch.map((item) => ({ categoryId: item.categoryId, stageId: item.stageId })));
    if (batch.length < PAGE_SIZE) return buildTruckEvidence(items);
  }
  throw new Error(`Bitrix has more than ${MAX_ITEM_PAGES * PAGE_SIZE} truck items; schema evidence is incomplete`);
}

async function readTruckStages(call, entityTypeId, categories) {
  if (categories.length > MAX_TRUCK_CATEGORIES) {
    throw new Error(`Bitrix returned more than ${MAX_TRUCK_CATEGORIES} Trucks categories; schema selection is ambiguous`);
  }
  const pages = await Promise.all(categories.map(async (category) => {
    const categoryId = Number(category.id ?? category.ID);
    const result = await call('crm.status.list', {
      filter: { ENTITY_ID: `DYNAMIC_${entityTypeId}_STAGE_${categoryId}` },
      order: { SORT: 'ASC' },
    });
    return rows(result, 'statuses').map((stage) => ({ ...stage, __categoryId: categoryId }));
  }));
  return pages.flat();
}

function activeStateValid(active, catalog, evidence) {
  if (!active?.mapping || !activeSchemaSource(active.source)) return false;
  return validateMapping(active.mapping, catalog).ok
    && assessEvidence(active.mapping, evidence).ok;
}

function activeStateProven(active) {
  return Boolean(active?.mapping
    && activeSchemaSource(active.source)
    && Number(active.mapping.evidence?.selectedActiveItems) > 0);
}

async function discoverBitrixSchema(deps = defaultDeps()) {
  let evidence = {};
  let diagnostic = {};
  try {
    const state = typeof deps.getSchemaState === 'function'
      ? await deps.getSchemaState() : { active: null, candidate: null };
    const [rawCategories, rawTypes] = await Promise.all([
      deps.call('crm.category.list', { entityTypeId: 2 }),
      deps.call('crm.type.list', {}),
    ]);
    const categories = rows(rawCategories, 'categories');
    const types = rows(rawTypes, 'types');
    if (!categories.length || !types.length) {
      return recordFallback('Bitrix returned no pipeline or smart-process catalogue', deps);
    }

    let structure = resolveStructure({ categories, types });
    let aiUsed = false;
    let confidence = 100;
    if (!structure.categoryId || !structure.truckEntityTypeId) {
      const picked = structureFromAi(await deps.askStructure({ categories, types }), categories, types);
      if (!picked) return recordFallback('the driver pipeline or Trucks process is ambiguous', deps);
      structure = picked;
      confidence = picked.confidence;
      aiUsed = true;
    }

    const [fields, rawDealStages, rawTruckCategories] = await Promise.all([
      deps.call('crm.deal.fields', {}),
      deps.call('crm.status.list', {
        filter: { ENTITY_ID: `DEAL_STAGE_${structure.categoryId}` }, order: { SORT: 'ASC' },
      }),
      deps.call('crm.category.list', { entityTypeId: structure.truckEntityTypeId }),
    ]);
    const dealStages = rows(rawDealStages, 'statuses');
    const truckCategories = rows(rawTruckCategories, 'categories');
    evidence = await readTruckEvidence(deps.call, structure.truckEntityTypeId);
    const truckStages = await readTruckStages(deps.call, structure.truckEntityTypeId, truckCategories);
    const catalog = { categories, types, fields, dealStages, truckCategories, truckStages };

    const semantics = resolveSemantics({
      fields, dealStages, truckCategories, truckStages,
      truckEntityTypeId: structure.truckEntityTypeId,
    });
    let mapping = { ...structure, ...semantics };
    let sourceOverride = null;
    let historicalUsed = false;
    diagnostic = summarizeEvidence(mapping, catalog, evidence);
    let evidenceCheck = complete(mapping) ? assessEvidence(mapping, evidence) : { ok: false };

    const activeCatalogMatches = Boolean(state.active?.mapping?.catalogSignature
      && state.active.mapping.catalogSignature === catalogSignature(state.active.mapping, catalog));
    if ((!complete(mapping) || !evidenceCheck.ok)
      && activeCatalogMatches && activeStateValid(state.active, catalog, evidence)) {
      mapping = { ...state.active.mapping };
      confidence = Number(state.active.confidence ?? confidence);
      sourceOverride = state.active.source;
      evidenceCheck = assessEvidence(mapping, evidence);
    }

    if (!complete(mapping) || !evidenceCheck.ok) {
      const answer = await deps.askSemantics({
        fields, dealStages, truckCategories, truckStages, evidence,
        previousMapping: state.active?.mapping || null,
      });
      mapping = mergeAiSemantics(mapping, answer);
      diagnostic = summarizeEvidence(mapping, catalog, evidence);
      if (Number(answer?.confidence) >= MIN_AI_CONFIDENCE) {
        confidence = Math.min(confidence, Number(answer.confidence));
        aiUsed = true;
      }
      evidenceCheck = complete(mapping) ? assessEvidence(mapping, evidence) : { ok: false };
    }

    if (!complete(mapping) || !evidenceCheck.ok) {
      const historical = resolveHistoricalTruck(mapping, catalog, evidence);
      if (historical.matched) {
        mapping = historical.mapping;
        sourceOverride = 'catalog_historical';
        historicalUsed = true;
        evidenceCheck = assessEvidence(mapping, evidence);
      }
    }

    const valid = validateMapping(mapping, catalog);
    if (!valid.ok) return recordFallback(valid.reason, deps, diagnostic);
    if (!evidenceCheck.ok) return recordFallback(evidenceCheck.reason, deps, diagnostic);

    const activeValid = activeStateValid(state.active, catalog, evidence);
    const activeProven = activeStateProven(state.active);
    const staticCount = countSelected(STATIC_SCHEMA, evidence).activeItems;
    const activeCount = activeValid ? countSelected(state.active.mapping, evidence).activeItems : 0;
    const previousCount = activeProven
      ? Number(state.active.mapping.evidence.selectedActiveItems) : 0;
    evidenceCheck = assessEvidence(mapping, evidence, {
      baselineActiveCount: activeCount || previousCount || staticCount,
    });
    const described = describeMapping(mapping, catalog, evidence);
    const source = sourceOverride || (aiUsed ? 'ai_validated' : 'catalog_exact');
    const historicalProblem = historicalUsed
      ? 'the live Trucks labels are opaque; current catalogue and counts match the previously verified truck category and stages'
      : null;
    const proposed = {
      mapping: described,
      fingerprint: fingerprint(described),
      source,
      confidence,
      evidence: described.evidence,
      problem: historicalProblem || evidenceCheck.reason,
      anomalous: historicalUsed || evidenceCheck.anomalous,
      activeValid,
      activeProven,
      baseFingerprint: state.active?.fingerprint || null,
    };
    const observed = await deps.observeCandidate(proposed);
    if (observed?.status === 'active') {
      return {
        ...described, source, confidence, fingerprint: proposed.fingerprint,
        comparisonSafe: true, writeSafe: true,
      };
    }
    const reason = observed?.requiresApproval
      ? `${proposed.problem || 'the Bitrix structure changed'}; administrator approval is required after two matching checks`
      : `schema candidate seen ${observed?.seenCount || 1}/2; one more matching check is required`;
    return fallback(reason, 'candidate_pending');
  } catch (err) {
    return recordFallback(err?.message || err, deps, diagnostic);
  }
}

module.exports = {
  MIN_AI_CONFIDENCE, PAGE_SIZE, MAX_ITEM_PAGES, MAX_TRUCK_CATEGORIES,
  rows, fallback, recordFallback, structureFromAi, mergeAiSemantics,
  readTruckEvidence, readTruckStages, activeStateValid, activeStateProven,
  discoverBitrixSchema, defaultDeps,
};
