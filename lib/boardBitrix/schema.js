'use strict';

/**
 * Resolve the CURRENT Bitrix catalogue into the few roles Board sync needs.
 * Pure: the service fetches catalogues and may ask AI; everything returned by
 * either path is validated here against ids Bitrix actually listed.
 */
const crypto = require('node:crypto');

const {
  DEAL_FIELDS, STAGE, FLEET_BY_DRIVER_TYPE, STATIC_SCHEMA,
} = require('./vocabulary');
const { dealStagePrefix, truckStagePrefix, stageCodeProblem } = require('./stageCodes');

const ACTIVE_SCHEMA_SOURCES = Object.freeze([
  'catalog_exact', 'ai_validated', 'catalog_historical',
]);

const ROLE_ALIASES = Object.freeze({
  HOME: ['HOME', 'AT HOME'],
  VACATION: ['VACATION', 'ON VACATION'],
  SHOP: ['SHOP', 'IN SHOP', 'AT SHOP'],
  WORKING: ['WORKING', 'ON ROAD', 'ON THE ROAD', 'ACTIVE'],
});

const TRUCK_ACTIVE_ALIASES = Object.freeze([
  'ON THE ROAD', 'DRIVERS AT SHOPS', 'DRIVERS AT SHOP',
  'DRIVER WILL STOP SOON AND LEAVE',
]);

const FLEET_ALIASES = Object.freeze({
  company: ['COMPANY', 'COMPANY DRIVER'],
  owner_operator: ['OWNER OPERATOR', 'OWNER-OPERATOR', 'OWNER OP'],
  lease: ['LEASE', 'LEASE DRIVER'],
});

function words(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function idOf(row, names = ['id', 'ID']) {
  for (const name of names) {
    if (row?.[name] !== null && row?.[name] !== undefined && row?.[name] !== '') return String(row[name]);
  }
  return null;
}

/**
 * The first non-empty label a row carries. A "label" that is only the row's own
 * id says nothing: `crm.deal.fields` gives a custom field `title: "UF_CRM_…"`
 * (its code) and the words people read in `formLabel` / `listLabel`.
 */
function labelOf(row) {
  const own = new Set(['id', 'ID', 'STATUS_ID', 'entityTypeId', 'ENTITY_TYPE_ID']
    .map((key) => String(row?.[key] ?? '').trim()).filter(Boolean));
  for (const name of ['name', 'NAME', 'title', 'TITLE', 'formLabel', 'listLabel', 'value', 'VALUE']) {
    const value = String(row?.[name] ?? '').trim();
    if (value && !own.has(value)) return value;
  }
  return '';
}

function exactByLabel(rows, aliases) {
  const wanted = new Set(aliases.map(words));
  const matches = (rows || []).filter((row) => wanted.has(words(labelOf(row))));
  return matches.length === 1 ? matches[0] : null;
}

function currentOrExact(rows, currentId, aliases, idNames) {
  const exact = exactByLabel(rows, aliases);
  if (exact) return exact;
  const current = (rows || []).find((row) => idOf(row, idNames) === String(currentId));
  return current && !words(labelOf(current)) ? current : null;
}

function resolveStructure({ categories = [], types = [] } = {}) {
  const category = currentOrExact(categories, 3, ['4 DRIVER RELATION', 'DRIVER RELATION'], ['id', 'ID']);
  const truckType = currentOrExact(types, 1040, ['TRUCKS', 'TRUCK'], ['entityTypeId', 'ENTITY_TYPE_ID', 'id', 'ID']);
  return {
    categoryId: category ? Number(idOf(category)) : null,
    truckEntityTypeId: truckType ? Number(idOf(truckType, ['entityTypeId', 'ENTITY_TYPE_ID', 'id', 'ID'])) : null,
  };
}

function fieldRows(fields) {
  if (Array.isArray(fields)) return fields;
  return Object.entries(fields || {}).map(([id, value]) => ({ id, ...(value || {}) }));
}

function fieldByRole(fields, currentId, aliases) {
  const rows = fieldRows(fields);
  const exact = exactByLabel(rows, aliases);
  if (exact) return exact;
  const current = rows.find((row) => String(row.id || row.ID) === currentId);
  return current && !words(labelOf(current)) ? current : null;
}

function stageMap(stages) {
  const out = {};
  for (const [role, aliases] of Object.entries(ROLE_ALIASES)) {
    const exact = exactByLabel(stages, aliases);
    if (exact) { out[role] = idOf(exact); continue; }
    const current = (stages || []).find((row) => idOf(row) === STAGE[role]);
    if (current && !words(labelOf(current))) out[role] = idOf(current);
  }
  return out;
}

function enumItems(field) {
  const raw = field?.items || field?.ITEMS || field?.list || [];
  return Array.isArray(raw) ? raw : [];
}

function enumMap(field) {
  const out = {};
  const items = enumItems(field);
  for (const [fleet, aliases] of Object.entries(FLEET_ALIASES)) {
    const currentId = Object.entries(FLEET_BY_DRIVER_TYPE).find(([, value]) => value === fleet)?.[0];
    const current = items.find((item) => idOf(item, ['id', 'ID', 'value', 'VALUE']) === currentId);
    const exact = exactByLabel(items, aliases);
    // A known id is only a fallback for portals that omit enum labels. If an
    // administrator reuses that id for another value, its live label wins and
    // the old snapshot must not silently redefine a driver's fleet.
    const found = exact || (current && !words(labelOf(current)) ? current : null);
    if (found) out[idOf(found, ['id', 'ID', 'value', 'VALUE'])] = fleet;
  }
  // Some portals omit enum items from crm.deal.fields. The current values are
  // still safe for reading; write safety below remains about stage ids only.
  return Object.keys(out).length ? out : { ...FLEET_BY_DRIVER_TYPE };
}

function enabledSetting(value) {
  return value === true || value === 1 || ['Y', 'YES', 'TRUE', '1'].includes(words(value));
}

function linksToEntity(field, entityTypeId) {
  if (!Number(entityTypeId)) return false;
  const wanted = words(`DYNAMIC_${Number(entityTypeId)}`);
  const settings = field?.settings || field?.SETTINGS || {};
  return Object.entries(settings).some(([key, value]) => (
    words(key) === wanted && enabledSetting(value)
  ) || words(value) === wanted);
}

function fleetEnumField(fields) {
  const matches = fieldRows(fields).filter((field) => {
    const found = new Set();
    for (const item of enumItems(field)) {
      for (const [fleet, aliases] of Object.entries(FLEET_ALIASES)) {
        if (aliases.map(words).includes(words(labelOf(item)))) found.add(fleet);
      }
    }
    return found.size === Object.keys(FLEET_ALIASES).length;
  });
  return matches.length === 1 ? matches[0] : null;
}

function linkedEntityField(fields, entityTypeId) {
  const matches = fieldRows(fields).filter((field) => linksToEntity(field, entityTypeId));
  return matches.length === 1 ? matches[0] : null;
}

function resolveSemantics({
  fields = {}, dealStages = [], truckCategories = [], truckStages = [], truckEntityTypeId = null,
} = {}) {
  const truckField = fieldByRole(fields, DEAL_FIELDS.truck,
    ['ASSIGNED TRUCK', 'TRUCK ASSIGNED', 'DRIVER ASSIGNED TRUCK'])
    || linkedEntityField(fields, truckEntityTypeId);
  const driverTypeField = fieldByRole(fields, DEAL_FIELDS.driverType,
    ['PERF DRIVER TYPE', 'DRIVER TYPE', 'DRIVER FLEET TYPE'])
    || fleetEnumField(fields);
  // A Trucks process with ONE pipeline leaves nothing to choose between: its
  // only category holds every truck, whatever Bitrix calls it ("Default
  // pipeline"). Two or more with no matching label stay unresolved.
  const category = currentOrExact(truckCategories, 17, ['TRUCKS', 'TRUCK'], ['id', 'ID'])
    || ((truckCategories || []).length === 1 ? truckCategories[0] : null);
  const categoryId = category ? Number(idOf(category)) : null;
  const inCategory = (row) => row?.__categoryId == null
    || Number(row.__categoryId) === categoryId;
  const active = (truckStages || []).filter((row) => inCategory(row)
    && TRUCK_ACTIVE_ALIASES.includes(words(labelOf(row))));
  return {
    dealFields: {
      truck: truckField ? String(truckField.id || truckField.ID) : null,
      driverType: driverTypeField ? String(driverTypeField.id || driverTypeField.ID) : null,
    },
    stageByRole: stageMap(dealStages),
    fleetByDriverType: enumMap(driverTypeField),
    truckCategoryId: category ? Number(idOf(category)) : null,
    activeTruckStageIds: active.map((row) => idOf(row)).filter(Boolean),
  };
}

/**
 * The truck category and active stages verified before Bitrix's labels became
 * opaque, accepted again ONLY when the live catalogue still lists every one of
 * them and the live counts put trucks there. Never a guess: each refusal says
 * which check failed, so the recorded problem names the real cause.
 */
function resolveHistoricalTruck(mapping, catalog, evidence) {
  const refuse = (reason) => ({ mapping, matched: false, reason });
  if (Number(mapping?.truckEntityTypeId) !== Number(STATIC_SCHEMA.truckEntityTypeId)) {
    return refuse(`the Trucks process is not the previously verified ${STATIC_SCHEMA.truckEntityTypeId}`);
  }
  const categoryId = Number(STATIC_SCHEMA.truckCategoryId);
  const selectedCategory = Number(mapping?.truckCategoryId || categoryId);
  const selectedStages = (mapping?.activeTruckStageIds || []).map(String);
  const historicalStages = STATIC_SCHEMA.activeTruckStageIds.map(String);
  if (selectedCategory !== categoryId) {
    return refuse(`the selected Trucks category is not the previously verified ${categoryId}`);
  }
  if (selectedStages.some((stageId) => !historicalStages.includes(stageId))) {
    return refuse('a selected active-truck stage is not one of the previously verified stages');
  }
  if (!(catalog?.truckCategories || []).some((row) => Number(idOf(row)) === categoryId)) {
    return refuse(`Bitrix no longer lists Trucks category ${categoryId}`);
  }
  const missing = historicalStages.filter((stageId) => !(catalog?.truckStages || []).some(
    (row) => idOf(row) === stageId && Number(row?.__categoryId) === categoryId,
  ));
  if (missing.length) {
    return refuse(`Bitrix no longer lists the previously verified truck stage(s) ${missing.join(', ')}`);
  }
  const categoryItems = Number(evidence?.categoryCounts?.[String(categoryId)] || 0);
  const activeItems = historicalStages.reduce((sum, stageId) => (
    sum + Number(evidence?.stageCounts?.[stageId] || 0)
  ), 0);
  if (categoryItems < 1) return refuse(`Trucks category ${categoryId} holds no current truck items`);
  if (activeItems < 1) return refuse('the previously verified active-truck stages hold no current truck items');
  return {
    mapping: {
      ...mapping,
      truckCategoryId: categoryId,
      activeTruckStageIds: historicalStages,
    },
    matched: true,
  };
}

function activeSchemaSource(source) {
  return ACTIVE_SCHEMA_SOURCES.includes(source);
}

function catalogSignature(mapping, catalog) {
  const sortRows = (rows, names) => (rows || []).map((row) => ({
    id: idOf(row, names),
    label: labelOf(row),
    semantic: String(row?.semantics ?? row?.SEMANTICS ?? ''),
    type: String(row?.type ?? row?.TYPE ?? ''),
  })).filter((row) => row.id).sort((a, b) => a.id.localeCompare(b.id));
  const selectedFields = new Set(Object.values(mapping?.dealFields || {}).map(String));
  const fields = fieldRows(catalog?.fields).filter((row) => (
    selectedFields.has(String(row.id || row.ID))
  )).map((row) => ({
    id: String(row.id || row.ID),
    label: labelOf(row),
    type: String(row.type ?? row.TYPE ?? ''),
    items: enumItems(row).map((item) => ({
      id: idOf(item, ['id', 'ID', 'value', 'VALUE']), label: labelOf(item),
    })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
  })).sort((a, b) => a.id.localeCompare(b.id));
  const categoryId = Number(mapping?.truckCategoryId);
  const stable = {
    driverPipeline: sortRows((catalog?.categories || []).filter((row) => (
      Number(idOf(row)) === Number(mapping?.categoryId)
    ))),
    truckProcess: sortRows((catalog?.types || []).filter((row) => (
      Number(idOf(row, ['entityTypeId', 'ENTITY_TYPE_ID', 'id', 'ID']))
        === Number(mapping?.truckEntityTypeId)
    )), ['entityTypeId', 'ENTITY_TYPE_ID', 'id', 'ID']),
    fields,
    driverStages: sortRows(catalog?.dealStages),
    truckCategory: sortRows((catalog?.truckCategories || []).filter((row) => (
      Number(idOf(row)) === categoryId
    ))),
    truckStages: sortRows((catalog?.truckStages || []).filter((row) => (
      Number(row?.__categoryId) === categoryId
    ))),
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function incompleteReason(mapping) {
  const missing = [];
  if (!(Number(mapping?.categoryId) > 0)) missing.push('driver pipeline');
  if (!(Number(mapping?.truckEntityTypeId) > 0)) missing.push('Trucks process');
  if (!mapping?.dealFields?.truck) missing.push('assigned-truck field');
  if (!mapping?.dealFields?.driverType) missing.push('driver-type field');
  for (const role of ['HOME', 'VACATION', 'SHOP', 'WORKING']) {
    if (!mapping?.stageByRole?.[role]) missing.push(`${role} stage`);
  }
  if (!(Number(mapping?.truckCategoryId) > 0)) missing.push('Trucks pipeline');
  if (!Array.isArray(mapping?.activeTruckStageIds) || !mapping.activeTruckStageIds.length) {
    missing.push('active-truck stages');
  }
  return missing.length ? `the schema is missing ${missing.join(', ')}` : null;
}

function complete(mapping) {
  return Boolean(
    Number(mapping?.categoryId) > 0
    && Number(mapping?.truckEntityTypeId) > 0
    && mapping?.dealFields?.truck
    && mapping?.dealFields?.driverType
    && ['HOME', 'VACATION', 'SHOP', 'WORKING'].every((role) => mapping?.stageByRole?.[role])
    && Number(mapping?.truckCategoryId) > 0
    && Array.isArray(mapping?.activeTruckStageIds)
    && mapping.activeTruckStageIds.length > 0
  );
}

function validateMapping(mapping, catalog) {
  if (!complete(mapping)) return { ok: false, reason: incompleteReason(mapping) };
  // A stage is a Bitrix stage code of the selected pipeline, never a row number
  // (lib/boardBitrix/stageCodes.js): STAGE_ID is what a live sync writes.
  const dealPrefix = dealStagePrefix(mapping.categoryId);
  for (const id of Object.values(mapping.stageByRole)) {
    const problem = stageCodeProblem(id, dealPrefix);
    if (problem) return { ok: false, reason: `a driver stage is invalid: ${problem}` };
  }
  const truckPrefix = truckStagePrefix(mapping.truckEntityTypeId, mapping.truckCategoryId);
  for (const id of mapping.activeTruckStageIds) {
    const problem = stageCodeProblem(id, truckPrefix);
    if (problem) return { ok: false, reason: `an active-truck stage is invalid: ${problem}` };
  }
  const ids = (rows, names) => new Set((rows || []).map((r) => idOf(r, names)).filter(Boolean));
  if (!ids(catalog.categories).has(String(mapping.categoryId))) return { ok: false, reason: 'the selected driver pipeline was not returned by Bitrix' };
  if (!ids(catalog.types, ['entityTypeId', 'ENTITY_TYPE_ID', 'id', 'ID']).has(String(mapping.truckEntityTypeId))) {
    return { ok: false, reason: 'the selected Trucks process was not returned by Bitrix' };
  }
  const fields = new Set(fieldRows(catalog.fields).map((r) => String(r.id || r.ID)));
  if (!fields.has(mapping.dealFields.truck) || !fields.has(mapping.dealFields.driverType)) {
    return { ok: false, reason: 'the selected driver fields were not returned by Bitrix' };
  }
  if (mapping.dealFields.truck === mapping.dealFields.driverType) {
    return { ok: false, reason: 'assigned truck and driver type must be two different Bitrix fields' };
  }
  const stages = ids(catalog.dealStages);
  if (!Object.values(mapping.stageByRole).every((id) => stages.has(String(id)))) {
    return { ok: false, reason: 'a selected driver stage was not returned by Bitrix' };
  }
  const uniqueStages = new Set(Object.values(mapping.stageByRole));
  if (uniqueStages.size !== 4) return { ok: false, reason: 'HOME, VACATION, SHOP and WORKING must be four different stages' };
  if (!ids(catalog.truckCategories).has(String(mapping.truckCategoryId))) {
    return { ok: false, reason: 'the selected Trucks pipeline was not returned by Bitrix' };
  }
  const truckStages = ids(catalog.truckStages);
  if ((mapping.activeTruckStageIds || []).some((id) => !truckStages.has(String(id)))) {
    return { ok: false, reason: 'a selected active-truck stage was not returned by Bitrix' };
  }
  const wrongCategoryStage = (mapping.activeTruckStageIds || []).some((id) => {
    const row = (catalog.truckStages || []).find((stage) => idOf(stage) === String(id));
    return row?.__categoryId != null && Number(row.__categoryId) !== Number(mapping.truckCategoryId);
  });
  if (wrongCategoryStage) {
    return { ok: false, reason: 'a selected active-truck stage belongs to another Trucks category' };
  }
  return { ok: true };
}

function fingerprint(mapping) {
  const stable = {
    categoryId: Number(mapping.categoryId),
    truckEntityTypeId: Number(mapping.truckEntityTypeId),
    truckCategoryId: Number(mapping.truckCategoryId) || null,
    dealFields: mapping.dealFields,
    stageByRole: mapping.stageByRole,
    fleetByDriverType: mapping.fleetByDriverType,
    activeTruckStageIds: [...(mapping.activeTruckStageIds || [])].sort(),
    catalogSignature: mapping.catalogSignature || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

module.exports = {
  ROLE_ALIASES, TRUCK_ACTIVE_ALIASES, FLEET_ALIASES, ACTIVE_SCHEMA_SOURCES,
  words, idOf, labelOf, fieldRows, resolveStructure, resolveSemantics,
  enumItems, linksToEntity, fleetEnumField, linkedEntityField, incompleteReason,
  resolveHistoricalTruck, activeSchemaSource, catalogSignature,
  complete, validateMapping, fingerprint,
};
