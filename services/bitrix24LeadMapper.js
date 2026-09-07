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
      // Nowhere to put it — the portal has no matching lead field. The answer
      // still reaches the CRM in COMMENTS (see buildTrackingComments), because
      // "do you have 2 years of experience" is the reason a recruiter opens the
      // lead at all, and silently dropping it makes Bitrix look like the driver
      // never answered.
      console.warn('[Bitrix24] No Bitrix field for custom Meta key:', metaKey);
      continue;
    }
    mappedMetaKeys.add(metaKey);
    setBitrixField(fields, resolved.name, value, resolved.meta);
  }

  return { fields, mappedMetaKeys, normalizedMap };
}

/**
 * Once per process — this runs per lead, and a repeated warning is a warning
 * nobody reads.
 */
let warnedInertAssignedBy = false;

function warnInertAssignedByOnce(value) {
  if (warnedInertAssignedBy) return;
  warnedInertAssignedBy = true;
  console.warn(
    `[Bitrix24] BITRIX24_ASSIGNED_BY_ID is "${value}", which is not a numeric Bitrix user ID — `
    + 'it is ignored, and new leads are assigned to the inbound webhook\'s owner. '
    + 'Set it to the user id from the Bitrix profile URL (/company/personal/user/<id>/), '
    + 'or leave it blank if a Bitrix distribution rule assigns leads.'
  );
}

/** Test seam: forget that the warning was emitted. */
function resetInertAssignedByWarning() {
  warnedInertAssignedBy = false;
}

/** "do_you_have_2_years_of_experience" → "Do you have 2 years of experience". */
function humanizeMetaKey(key) {
  const words = String(key || '').split('_').filter(Boolean);
  if (!words.length) return '';
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

/**
 * The lead's answers that no Bitrix field could take, as comment lines.
 *
 * This is the safety net for the gap between a Facebook form and a Bitrix
 * portal: form questions arrive whether or not anyone has created a matching
 * lead field, and the mapper can only fill fields that exist. Before this, an
 * unmatched answer produced a console warning and nothing else — the recruiter
 * opened the lead in Bitrix and saw a name and a phone number, with the
 * qualifying answers nowhere. Field mapping is still the goal; this makes the
 * un-mapped case lossy in appearance only.
 */
function buildAnswerLines(normalizedMap, mappedMetaKeys) {
  const lines = [];
  for (const [key, value] of Object.entries(normalizedMap || {})) {
    if (!value || mappedMetaKeys.has(key)) continue;
    const label = humanizeMetaKey(key);
    if (label) lines.push(`${label}: ${value}`);
  }
  return lines;
}

function buildTrackingComments({
  leadData,
  connection,
  leadgenId,
  formId,
  answerLines = [],
}) {
  const lines = ['Facebook lead (bot-backend)', ''];
  // The answers first: they are what a recruiter reads. Provenance after.
  if (answerLines.length) {
    lines.push('Answers not stored in a Bitrix field:');
    lines.push(...answerLines);
    lines.push('');
  }
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
  fields.COMMENTS = buildTrackingComments({
    leadData,
    connection,
    leadgenId,
    formId,
    answerLines: buildAnswerLines(normalizedMap, mappedMetaKeys),
  });

  if (bitrixConfig.sourceDescription) {
    fields.SOURCE_DESCRIPTION = bitrixConfig.sourceDescription;
  }
  if (bitrixConfig.sourceId) {
    fields.SOURCE_ID = bitrixConfig.sourceId;
  }

  // STATUS_ID is a LEAD field. A deal's equivalent is STAGE_ID, set from the
  // pipeline config below — sending STATUS_ID on a deal is at best ignored and
  // at worst a rejected record, so it is scoped to leads deliberately.
  if (bitrixConfig.entity !== 'deal') {
    const statusId = mapConfig.statusId
      || (catalog ? findIncomingStatusId(catalog.statuses) : '')
      || '';
    if (statusId) fields.STATUS_ID = statusId;
  }

  const assignedBy = Number(bitrixConfig.assignedById);
  if (Number.isFinite(assignedBy) && assignedBy > 0) {
    fields.ASSIGNED_BY_ID = assignedBy;
  } else if (String(bitrixConfig.assignedById || '').trim()) {
    // Set to something that is not a Bitrix user ID — a NAME, most likely.
    // Bitrix only accepts the numeric id, so the value is inert and the lead is
    // assigned to whoever owns the inbound webhook. Worth saying out loud
    // rather than leaving as a config line that looks effective: the assignee
    // is now also what decides WHICH RECRUITER'S NUMBER texts the lead
    // (services/facebookLeadSmsSender.js).
    warnInertAssignedByOnce(bitrixConfig.assignedById);
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
  humanizeMetaKey,
  buildAnswerLines,
  resetInertAssignedByWarning,
  normalizeMetaFieldKey,
  splitNameFromFieldMap,
  resolveDisplayName,
  normalizeFieldMapKeys,
  applyMappedFields,
  buildTrackingComments,
  buildLeadComments: buildTrackingComments,
  buildBitrixCrmFields,
};
