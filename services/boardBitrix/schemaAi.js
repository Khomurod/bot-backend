'use strict';

/**
 * AI may interpret labels, never invent ids. The caller validates every answer
 * against the same catalogue before it can become a schema, and an uncertain
 * answer is treated exactly like no answer.
 */
const { runCapability, AiUnavailableError } = require('../ai/router');

const CAPABILITY = 'board_bitrix_schema_reading';

const SYSTEM = [
  'You map a Bitrix24 CRM catalogue for a trucking company.',
  'The Dispatcher Board is the source of truth. You are shown catalogue labels and opaque ids only, never driver data.',
  'Choose only ids present in the supplied lists. Never invent, edit, or infer an id that is not listed.',
  'DRIVER RELATION is the pipeline holding active drivers. Trucks is the smart process holding truck items.',
  'HOME means the driver is home; VACATION means away; SHOP means at a repair shop; WORKING means on the road or working.',
  'Aggregate item counts are evidence: choose active truck stages from the chosen truck category and explain the populated fleet, not an empty parallel process.',
  'If labels do not prove one unique answer, set understood=false.',
  'Answer JSON only and include confidence from 0 to 100.',
].join('\n');

function clipRows(rows, idNames, max = 100) {
  return (rows || []).slice(0, max).map((row) => {
    let id = null;
    for (const name of idNames) {
      if (row?.[name] != null) { id = String(row[name]); break; }
    }
    return {
      id,
      label: String(row?.name ?? row?.NAME ?? row?.title ?? row?.TITLE
        ?? row?.formLabel ?? row?.listLabel ?? '').slice(0, 120),
    };
  }).filter((row) => row.id);
}

function validateBase(_text, parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { message: 'not a JSON object' };
  if (typeof parsed.understood !== 'boolean') return { message: 'understood must be boolean' };
  if (!Number.isFinite(Number(parsed.confidence))) return { message: 'confidence must be a number' };
  return true;
}

function ids(rows, names) {
  return new Set((rows || []).map((row) => {
    for (const name of names) {
      if (row?.[name] != null) return String(row[name]);
    }
    return null;
  }).filter(Boolean));
}

function semanticsValidator({ fields, dealStages, truckCategories, truckStages, evidence = {} }) {
  const fieldRows = Array.isArray(fields)
    ? fields : Object.entries(fields || {}).map(([id, row]) => ({ id, ...(row || {}) }));
  const fieldIds = ids(fieldRows, ['id', 'ID']);
  const dealStageIds = ids(dealStages, ['id', 'ID']);
  const categoryIds = ids(truckCategories, ['id', 'ID']);
  const truckStageIds = ids(truckStages, ['id', 'ID']);
  const stageCategory = new Map((truckStages || []).map((row) => [
    String(row.ID ?? row.id), row.__categoryId == null ? null : String(row.__categoryId),
  ]));
  return (text, parsed) => {
    const base = validateBase(text, parsed);
    if (base !== true || parsed.understood === false) return base;
    const selectedFields = [parsed.deal_fields?.truck, parsed.deal_fields?.driver_type].map(String);
    if (!selectedFields.every((id) => fieldIds.has(id))) return { message: 'selected deal field was not listed' };
    if (new Set(selectedFields).size !== 2) return { message: 'driver roles require two distinct deal fields' };
    const selectedDealStages = ['HOME', 'VACATION', 'SHOP', 'WORKING']
      .map((role) => String(parsed.stages?.[role]));
    if (!selectedDealStages.every((id) => dealStageIds.has(id))) return { message: 'selected driver stage was not listed' };
    if (new Set(selectedDealStages).size !== 4) return { message: 'driver roles require four distinct stages' };
    const categoryId = String(parsed.truck_category_id);
    if (!categoryIds.has(categoryId)) return { message: 'selected truck category was not listed' };
    if (Number(evidence.categoryCounts?.[categoryId] || 0) < 1) {
      return { message: 'selected truck category has no current items' };
    }
    if (!Array.isArray(parsed.active_truck_stage_ids) || !parsed.active_truck_stage_ids.length) {
      return { message: 'at least one active truck stage is required' };
    }
    const active = [...new Set(parsed.active_truck_stage_ids.map(String))];
    if (!active.every((id) => truckStageIds.has(id))) return { message: 'selected truck stage was not listed' };
    if (active.some((id) => stageCategory.get(id) !== categoryId)) {
      return { message: 'selected truck stage belongs to another category' };
    }
    const selectedItems = active.reduce((sum, id) => sum + Number(evidence.stageCounts?.[id] || 0), 0);
    if (selectedItems < 1) return { message: 'selected active truck stages have zero current items' };
    return true;
  };
}

async function askStructure({ categories, types }, deps = {}) {
  const run = deps.runCapability || runCapability;
  const answer = await run({
    capability: CAPABILITY,
    systemText: SYSTEM,
    userText: JSON.stringify({
      task: 'Choose the DRIVER RELATION deal pipeline and the Trucks smart process.',
      categories: clipRows(categories, ['id', 'ID'], 50),
      smart_processes: clipRows(types, ['entityTypeId', 'ENTITY_TYPE_ID', 'id', 'ID'], 50),
      answer_shape: {
        understood: true,
        category_id: 'one listed categories.id',
        truck_entity_type_id: 'one listed smart_processes.id',
        confidence: 0,
      },
    }),
    expects: 'json',
    validate: validateBase,
  });
  if (answer?.uncertain || !answer?.parsed?.understood) return null;
  return answer.parsed;
}

async function askSemantics({
  fields, dealStages, truckCategories, truckStages, evidence = {}, previousMapping = null,
}, deps = {}) {
  const run = deps.runCapability || runCapability;
  const fieldRows = Array.isArray(fields)
    ? fields : Object.entries(fields || {}).map(([id, row]) => ({ id, ...(row || {}) }));
  const categoryRows = clipRows(truckCategories, ['id', 'ID'], 50).map((row) => ({
    ...row, item_count: Number(evidence.categoryCounts?.[row.id] || 0),
  }));
  const stageRows = clipRows(truckStages, ['id', 'ID'], 150).map((row) => {
    const source = (truckStages || []).find((stage) => String(stage.ID ?? stage.id) === row.id);
    return {
      ...row,
      category_id: source?.__categoryId == null ? null : String(source.__categoryId),
      item_count: Number(evidence.stageCounts?.[row.id] || 0),
    };
  });
  const answer = await run({
    capability: CAPABILITY,
    systemText: SYSTEM,
    userText: JSON.stringify({
      task: 'Map the driver fields and stages. A truck is active in stages meaning on road, at shop, or about to leave.',
      evidence_rule: 'The selected truck category and active truck stages must be from one category and their item_count total must be greater than zero.',
      deal_fields: clipRows(fieldRows, ['id', 'ID'], 150),
      driver_stages: clipRows(dealStages, ['id', 'ID'], 100),
      truck_categories: categoryRows,
      truck_stages: stageRows,
      total_truck_items: Number(evidence.totalItems || 0),
      previous_schema: previousMapping ? {
        truck_category_id: previousMapping.truckCategoryId,
        active_truck_stage_ids: previousMapping.activeTruckStageIds,
        previous_active_items: previousMapping.evidence?.selectedActiveItems ?? null,
      } : null,
      answer_shape: {
        understood: true,
        deal_fields: { truck: 'listed field id', driver_type: 'listed field id' },
        stages: { HOME: 'listed stage id', VACATION: 'listed stage id', SHOP: 'listed stage id', WORKING: 'listed stage id' },
        truck_category_id: 'listed category id or null',
        active_truck_stage_ids: ['zero or more listed stage ids'],
        confidence: 0,
      },
    }),
    expects: 'json',
    validate: semanticsValidator({ fields, dealStages, truckCategories, truckStages, evidence }),
  });
  if (answer?.uncertain || !answer?.parsed?.understood) return null;
  return answer.parsed;
}

module.exports = {
  CAPABILITY, SYSTEM, askStructure, askSemantics,
  validateBase, semanticsValidator, AiUnavailableError,
};
