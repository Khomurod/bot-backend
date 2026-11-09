'use strict';

/**
 * Discover the current Bitrix schema. Exact labels win; AI is asked only for
 * labels the deterministic reader cannot settle. Every AI-selected id is then
 * checked against this same live catalogue. Failure degrades to the October
 * snapshot for READS ONLY — live writes are always blocked on a fallback.
 */
const { STATIC_SCHEMA } = require('../../lib/boardBitrix/vocabulary');
const {
  resolveStructure, resolveSemantics, complete, validateMapping, fingerprint,
} = require('../../lib/boardBitrix/schema');
const { askStructure, askSemantics } = require('./schemaAi');

const MIN_AI_CONFIDENCE = 85;

function defaultDeps() {
  /* eslint-disable global-require */
  return {
    call: require('../bitrix24DealStages').callBitrix,
    askStructure,
    askSemantics,
    recordSchema: (schema) => require('../../database/boardBitrix').recordSchema(schema),
  };
  /* eslint-enable global-require */
}

function rows(result, key) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.[key]) ? result[key] : [];
}

function fallback(problem) {
  return {
    ...STATIC_SCHEMA,
    dealFields: { ...STATIC_SCHEMA.dealFields },
    stageByRole: { ...STATIC_SCHEMA.stageByRole },
    fleetByDriverType: { ...STATIC_SCHEMA.fleetByDriverType },
    activeTruckStageIds: [...STATIC_SCHEMA.activeTruckStageIds],
    problem: String(problem || 'the live Bitrix schema could not be discovered')
      .replace(/\s+/g, ' ').trim().slice(0, 240),
    fingerprint: fingerprint(STATIC_SCHEMA),
  };
}

/**
 * Remember a failed catalogue check on the settings row, not in the shared
 * background-run summary (which is also read by the public health endpoint).
 * The stored mapping is the read-only fallback plus a catalogue-only reason;
 * it contains no driver, deal, truck or Board data.
 */
async function recordFallback(problem, deps) {
  const out = fallback(problem);
  if (typeof deps.recordSchema === 'function') {
    await Promise.resolve(deps.recordSchema({
      mapping: out,
      fingerprint: out.fingerprint,
      source: out.source,
      confidence: null,
    })).catch(() => {});
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

async function discoverBitrixSchema(deps = defaultDeps()) {
  try {
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
        filter: { ENTITY_ID: structure.categoryId ? `DEAL_STAGE_${structure.categoryId}` : 'DEAL_STAGE' },
        order: { SORT: 'ASC' },
      }),
      deps.call('crm.category.list', { entityTypeId: structure.truckEntityTypeId }),
    ]);
    const dealStages = rows(rawDealStages, 'statuses');
    const truckCategories = rows(rawTruckCategories, 'categories');
    const preliminary = resolveSemantics({ fields, dealStages, truckCategories, truckStages: [] });

    let truckStages = [];
    if (preliminary.truckCategoryId) {
      const rawTruckStages = await deps.call('crm.status.list', {
        filter: { ENTITY_ID: `DYNAMIC_${structure.truckEntityTypeId}_STAGE_${preliminary.truckCategoryId}` },
        order: { SORT: 'ASC' },
      });
      truckStages = rows(rawTruckStages, 'statuses');
    }

    let semantics = resolveSemantics({ fields, dealStages, truckCategories, truckStages });
    let mapping = { ...structure, ...semantics };
    let catalog = { categories, types, fields, dealStages, truckCategories, truckStages };

    if (!complete(mapping) || !mapping.truckCategoryId || !mapping.activeTruckStageIds?.length) {
      let answer = await deps.askSemantics({ fields, dealStages, truckCategories, truckStages });
      mapping = mergeAiSemantics(mapping, answer);
      if (Number(answer?.confidence) >= MIN_AI_CONFIDENCE) {
        confidence = Math.min(confidence, Number(answer.confidence));
        aiUsed = true;
      }
      // AI may identify a truck category whose stages were not fetched yet.
      if (!truckStages.length && mapping.truckCategoryId) {
        const rawTruckStages = await deps.call('crm.status.list', {
          filter: { ENTITY_ID: `DYNAMIC_${structure.truckEntityTypeId}_STAGE_${mapping.truckCategoryId}` },
          order: { SORT: 'ASC' },
        });
        truckStages = rows(rawTruckStages, 'statuses');
        catalog = { ...catalog, truckStages };
        semantics = resolveSemantics({ fields, dealStages, truckCategories, truckStages });
        mapping = {
          ...mapping,
          activeTruckStageIds: mapping.activeTruckStageIds?.length
            ? mapping.activeTruckStageIds : semantics.activeTruckStageIds,
        };
        if (!mapping.activeTruckStageIds?.length) {
          answer = await deps.askSemantics({ fields, dealStages, truckCategories, truckStages });
          mapping = mergeAiSemantics(mapping, answer);
          if (Number(answer?.confidence) >= MIN_AI_CONFIDENCE) {
            confidence = Math.min(confidence, Number(answer.confidence));
            aiUsed = true;
          }
        }
      }
    }

    const valid = validateMapping(mapping, catalog);
    if (!valid.ok) return recordFallback(valid.reason, deps);
    const out = {
      ...mapping,
      source: aiUsed ? 'ai_validated' : 'catalog_exact',
      confidence,
      writeSafe: true,
    };
    out.fingerprint = fingerprint(out);
    await Promise.resolve(deps.recordSchema({
      mapping: out,
      fingerprint: out.fingerprint,
      source: out.source,
      confidence: out.confidence,
    })).catch(() => {});
    return out;
  } catch (err) {
    return recordFallback(err?.message || err, deps);
  }
}

module.exports = {
  MIN_AI_CONFIDENCE, rows, fallback, recordFallback, structureFromAi, mergeAiSemantics,
  discoverBitrixSchema, defaultDeps,
};
