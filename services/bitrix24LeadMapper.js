const PRETTY_FIELD_LABELS = {
  full_name: 'Name',
  first_name: 'First Name',
  last_name: 'Last Name',
  email: 'Email',
  phone_number: 'Phone',
  phone: 'Phone',
  city: 'City',
  state: 'State',
  zip_code: 'ZIP',
  country: 'Country',
  company_name: 'Company',
  job_title: 'Job Title',
  message: 'Message',
  comments: 'Comments',
};

function bitrixMultiField(value, valueType = 'WORK') {
  const trimmed = String(value || '').trim();
  if (!trimmed) return undefined;
  return [{ VALUE: trimmed, VALUE_TYPE: valueType }];
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

function buildLeadComments({
  fieldMap,
  leadData,
  connection,
  leadgenId,
  formId,
}) {
  const lines = ['Facebook lead (bot-backend)', ''];
  const shown = new Set();

  for (const [key, label] of Object.entries(PRETTY_FIELD_LABELS)) {
    if (fieldMap[key]) {
      lines.push(`${label}: ${fieldMap[key]}`);
      shown.add(key);
    }
  }

  for (const [key, value] of Object.entries(fieldMap)) {
    if (!shown.has(key)) {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      lines.push(`${label}: ${value}`);
    }
  }

  lines.push('');
  if (connection?.page_name) lines.push(`Page: ${connection.page_name}`);
  if (connection?.page_id) lines.push(`Page ID: ${connection.page_id}`);
  if (formId) lines.push(`Form ID: ${formId}`);
  if (leadgenId) lines.push(`Leadgen ID: ${leadgenId}`);
  if (leadData?.id) lines.push(`Meta lead ID: ${leadData.id}`);
  if (leadData?.created_time) lines.push(`Submitted: ${leadData.created_time}`);

  return lines.join('\n');
}

/**
 * @param {object} params
 * @param {Record<string, string>} params.fieldMap
 * @param {object} params.leadData
 * @param {object} params.connection
 * @param {string} params.leadgenId
 * @param {string} params.formId
 * @param {object} params.bitrixConfig
 */
function buildBitrixCrmFields({
  fieldMap,
  leadData,
  connection,
  leadgenId,
  formId,
  bitrixConfig,
}) {
  const pageName = connection?.page_name || 'Facebook Page';
  const displayName = resolveDisplayName(fieldMap, pageName);
  const { firstName, lastName } = splitNameFromFieldMap(fieldMap);
  const phone = fieldMap.phone_number || fieldMap.phone || '';
  const email = fieldMap.email || '';

  const fields = {
    TITLE: `Facebook Lead – ${displayName}`,
    COMMENTS: buildLeadComments({
      fieldMap,
      leadData,
      connection,
      leadgenId,
      formId,
    }),
    SOURCE_DESCRIPTION: bitrixConfig.sourceDescription,
  };

  if (firstName) fields.NAME = firstName;
  if (lastName) fields.LAST_NAME = lastName;

  const phoneField = bitrixMultiField(phone);
  if (phoneField) fields.PHONE = phoneField;

  const emailField = bitrixMultiField(email);
  if (emailField) fields.EMAIL = emailField;

  if (bitrixConfig.sourceId) fields.SOURCE_ID = bitrixConfig.sourceId;

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
  splitNameFromFieldMap,
  resolveDisplayName,
  buildLeadComments,
  buildBitrixCrmFields,
};
