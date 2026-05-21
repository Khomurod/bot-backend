const {
  findFieldByTitleHints,
  resolveEnumerationValue,
  findIncomingStatusId,
} = require('./bitrix24FieldCatalog');
const { resolveFieldMapConfig } = require('./bitrix24FieldMapLoader');

const MULTI_VALUE_FIELDS = new Set(['EMAIL', 'PHONE', 'WEB', 'IM']);

function bitrixMultiField(value, valueType = 'WORK') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return undefined;
  return [{ VALUE: trimmed, VALUE_TYPE: valueType }];
}

function normalizeMetaFieldKey(key) {
  return String(key || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function splitNameFromFieldMap(fieldMap) {
  const full = String(fieldMap.full_name || '').trim();
  if (full) {
    const parts = full.split(/\s+/).filter(Boolean);
    if (parts.length === 1) {
      return { firstName: parts[0], lastName: '' };
    }
    return {
      firstName: parts.slice(0, -1).join(' '),
      lastName: parts[parts.length - 1],
    };
  }
  return {
    firstName: String(fieldMap.first_name || '').trim(),
    lastName: String(fieldMap.last_name || '').trim(),
  };
}

function resolveDisplayName(fieldMap, pageName) {
  const { firstName, lastName } = splitNameFromFieldMap(fieldMap);
  const combined = `${firstName} ${lastName}`.trim();
  return combined || pageName || 'Facebook Lead';
}

function normalizeFieldMapKeys(fieldMap) {
  const out = {};
  for (const [key, value] of Object.entries(fieldMap || {})) {
    const normalized = normalizeMetaFieldKey(key);
    if (!normalized || out[normalized]) continue;
    out[normalized] = String(value || '').trim();
  }
  return out;
}

function setBitrixField(fields, bitrixField, value, fieldMeta) {
  if (!bitrixField || value === undefined || value === null || String(value).trim() === '') {
    return;
  }
  const resolved = fieldMeta?.type === 'enumeration'
    ? resolveEnumerationValue(fieldMeta, value)
    : value;

  if (MULTI_VALUE_FIELDS.has(bitrixField)) {
    const multi = bitrixMultiField(resolved);
    if (multi) fields[bitrixField] = multi;
    return;
  }
  fields[bitrixField] = resolved;
}

function applySplitName(fields, fieldMap, targetFields) {
  const { firstName, lastName } = splitNameFromFieldMap(fieldMap);
  const [firstTarget, lastTarget] = targetFields || ['NAME', 'LAST_NAME'];
  if (firstName && firstTarget) fields[firstTarget] = firstName;
  if (lastName && lastTarget) fields[lastTarget] = lastName;
}

function resolveCustomBitrixField(rule, catalog) {
  if (!rule) return null;
  if (typeof rule === 'string') return { name: rule, meta: catalog?.fields?.[rule] };
  if (rule.bitrixField) {
    return { name: rule.bitrixField, meta: catalog?.fields?.[rule.bitrixField] };
  }
  if (rule.matchTitle && catalog?.fields) {
    const found = findFieldByTitleHints(catalog.fields, rule.matchTitle);
    if (found) return found;
  }
  return null;
}

function applyMappedFields(fieldMap, mapConfig, catalog) {
  const fields = {};
  const mappedMetaKeys = new Set();
  const normalizedMap = normalizeFieldMapKeys(fieldMap);

  for (const [metaKey, rule] of Object.entries(mapConfig.defaults || {})) {
    const value = normalizedMap[metaKey];
    if (!value) continue;
    mappedMetaKeys.add(metaKey);

    if (typeof rule === 'string') {
      setBitrixField(fields, rule, value, catalog?.fields?.[rule]);
      continue;
    }
    if (rule.split) {
      applySplitName(fields, { full_name: value, first_name: normalizedMap.first_name, last_name: normalizedMap.last_name }, rule.split);
      continue;
    }
    if (rule.bitrixField) {
      setBitrixField(fields, rule.bitrixField, value, catalog?.fields?.[rule.bitrixField]);
    }
  }

  if (normalizedMap.full_name && !mappedMetaKeys.has('full_name')) {
    const splitRule = mapConfig.defaults?.full_name;
    if (splitRule?.split) {
      applySplitName(fields, normalizedMap, splitRule.split);
      mappedMetaKeys.add('full_name');
    }
  }

  for (const [metaKey, rule] of Object.entries(mapConfig.custom || {})) {
    const value = normalizedMap[metaKey];
    if (!value) continue;

    const resolved = resolveCustomBitrixField(rule, catalog);
    if (!resolved?.name) {
      console.warn('[Bitrix24] No Bitrix field for custom Meta key:', metaKey);
      continue;
    }
    mappedMetaKeys.add(metaKey);
    setBitrixField(fields, resolved.name, value, resolved.meta);
  }

  return { fields, mappedMetaKeys, normalizedMap };
}

function buildTrackingComments({
  leadData,
  connection,
  leadgenId,
  formId,
}) {
  const lines = ['Facebook lead (bot-backend)', ''];
  if (connection?.page_name) lines.push(`Page: ${connection.page_name}`);
  if (connection?.page_id) lines.push(`Page ID: ${connection.page_id}`);
  if (formId) lines.push(`Form ID: ${formId}`);
  if (leadgenId) lines.push(`Leadgen ID: ${leadgenId}`);
  if (leadData?.id) lines.push(`Meta lead ID: ${leadData.id}`);
  if (leadData?.created_time) lines.push(`Submitted: ${leadData.created_time}`);
  return lines.join('\n');
}

function logUnmappedFields(normalizedMap, mappedMetaKeys) {
  for (const [key, value] of Object.entries(normalizedMap)) {
    if (!value || mappedMetaKeys.has(key)) continue;
    console.warn('[Bitrix24] Unmapped Meta field:', key, '=', value);
  }
}

/**
 * @param {object} params
 * @param {Record<string, string>} params.fieldMap
 * @param {object} params.leadData
 * @param {object} params.connection
 * @param {string} params.leadgenId
 * @param {string} params.formId
 * @param {object} params.bitrixConfig
 * @param {object} [params.catalog]
 */
function buildBitrixCrmFields({
  fieldMap,
  leadData,
  connection,
  leadgenId,
  formId,
  bitrixConfig,
  catalog = null,
}) {
  const pageName = connection?.page_name || 'Facebook Page';
  const displayName = resolveDisplayName(fieldMap, pageName);
  const mapConfig = resolveFieldMapConfig(formId);

  const { fields, mappedMetaKeys, normalizedMap } = applyMappedFields(
    fieldMap,
    mapConfig,
    catalog,
  );

  logUnmappedFields(normalizedMap, mappedMetaKeys);

  fields.TITLE = fields.TITLE || `Facebook Lead – ${displayName}`;
  fields.COMMENTS = buildTrackingComments({ leadData, connection, leadgenId, formId });

  if (bitrixConfig.sourceDescription) {
    fields.SOURCE_DESCRIPTION = bitrixConfig.sourceDescription;
  }
  if (bitrixConfig.sourceId) {
    fields.SOURCE_ID = bitrixConfig.sourceId;
  }

  const statusId = mapConfig.statusId
    || (catalog ? findIncomingStatusId(catalog.statuses) : '')
    || '';
  if (statusId) fields.STATUS_ID = statusId;

  const assignedBy = Number(bitrixConfig.assignedById);
  if (Number.isFinite(assignedBy) && assignedBy > 0) {
    fields.ASSIGNED_BY_ID = assignedBy;
  }

  if (bitrixConfig.entity === 'deal') {
    const categoryId = Number(bitrixConfig.dealCategoryId);
    const stageId = String(bitrixConfig.dealStageId || '').trim();
    if (Number.isFinite(categoryId) && categoryId > 0) {
      fields.CATEGORY_ID = categoryId;
    }
    if (stageId) fields.STAGE_ID = stageId;
  }

  return fields;
}

module.exports = {
  bitrixMultiField,
  normalizeMetaFieldKey,
  splitNameFromFieldMap,
  resolveDisplayName,
  normalizeFieldMapKeys,
  applyMappedFields,
  buildTrackingComments,
  buildLeadComments: buildTrackingComments,
  buildBitrixCrmFields,
};
