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

async function askSemantics({ fields, dealStages, truckCategories, truckStages }, deps = {}) {
  const run = deps.runCapability || runCapability;
  const fieldRows = Array.isArray(fields)
    ? fields : Object.entries(fields || {}).map(([id, row]) => ({ id, ...(row || {}) }));
  const answer = await run({
    capability: CAPABILITY,
    systemText: SYSTEM,
    userText: JSON.stringify({
      task: 'Map the driver fields and stages. A truck is active in stages meaning on road, at shop, or about to leave.',
      deal_fields: clipRows(fieldRows, ['id', 'ID'], 150),
      driver_stages: clipRows(dealStages, ['id', 'ID'], 100),
      truck_categories: clipRows(truckCategories, ['id', 'ID'], 50),
      truck_stages: clipRows(truckStages, ['id', 'ID'], 100),
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
    validate: validateBase,
  });
  if (answer?.uncertain || !answer?.parsed?.understood) return null;
  return answer.parsed;
}

module.exports = { CAPABILITY, SYSTEM, askStructure, askSemantics, validateBase, AiUnavailableError };
