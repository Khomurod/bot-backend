const PLACEHOLDER_DEFS = [
  { key: 'driver_name', label: 'Driver name', required: true },
  { key: 'first_name', label: 'First name', required: true },
  { key: 'last_name', label: 'Last name', required: true },
  { key: 'unit_number', label: 'Unit number', required: true },
  { key: 'driver_type', label: 'Driver type', required: true },
  { key: 'status', label: 'Status', required: true },
  { key: 'language', label: 'Language', required: true },
  { key: 'date_of_birth', label: 'Date of birth', required: true },
  { key: 'date_of_start', label: 'Date of start', required: true },
];
const { parseGroupName, extractUnitFromGroupName } = require('./driverGroupTitle');

const ALLOWED_KEYS = new Set(PLACEHOLDER_DEFS.map((p) => p.key));
const TOKEN_PATTERN = /\{([a-z][a-z0-9_]*)\}/gi;

function listBroadcastPlaceholders() {
  return PLACEHOLDER_DEFS.map((p) => ({ ...p }));
}

function normalizeToken(key) {
  return String(key || '').trim().toLowerCase();
}

function extractBroadcastTemplateTokens(template) {
  const text = String(template || '');
  const seen = new Set();
  let match = TOKEN_PATTERN.exec(text);
  while (match) {
    seen.add(normalizeToken(match[1]));
    match = TOKEN_PATTERN.exec(text);
  }
  TOKEN_PATTERN.lastIndex = 0;
  return [...seen];
}

function validateBroadcastTemplate(template) {
  const unknownTokens = extractBroadcastTemplateTokens(template)
    .filter((key) => !ALLOWED_KEYS.has(key));
  return {
    valid: unknownTokens.length === 0,
    unknownTokens,
  };
}

function formatDateValue(value) {
  if (!value) return '';
  const asDate = new Date(value);
  if (Number.isNaN(asDate.getTime())) return '';
  return asDate.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildBroadcastTemplateContext({ profile, group }) {
  const parsedGroup = parseGroupName(group?.group_name || '');
  const parsedName = String(parsedGroup.driver || '').trim();
  const nameParts = parsedName.split(/\s+/).filter(Boolean);
  const fallbackFirst = nameParts[0] || '';
  const fallbackLast = nameParts.slice(1).join(' ');

  const firstName = String(profile?.first_name || fallbackFirst || '').trim();
  const lastName = String(profile?.last_name || fallbackLast || '').trim();
  const driverName = [firstName, lastName].filter(Boolean).join(' ').trim();
  const inferredType = String(profile?.driver_type || '').trim()
    || (String(parsedGroup.type || '').toLowerCase().includes('company driver') ? 'company_driver' : 'owner');
  const fallbackUnit = extractUnitFromGroupName(group?.group_name || '');
  const fallbackDob = formatDateValue(group?.driver_birthday);
  const fallbackStart = formatDateValue(group?.created_at);
  return {
    driver_name: driverName,
    first_name: firstName,
    last_name: lastName,
    unit_number: String(profile?.unit_number || fallbackUnit || '').trim(),
    driver_type: inferredType,
    status: String(profile?.status || (group?.active === false ? 'inactive' : 'active')).trim(),
    language: String(profile?.language || group?.language || 'en').trim(),
    date_of_birth: formatDateValue(profile?.date_of_birth) || fallbackDob,
    date_of_start: formatDateValue(profile?.date_of_start) || fallbackStart,
  };
}

function renderBroadcastTemplateStrict(template, context = {}) {
  const text = String(template || '');
  const unknownTokens = [];
  const missingTokens = [];

  const rendered = text.replace(TOKEN_PATTERN, (raw, token) => {
    const key = normalizeToken(token);
    if (!ALLOWED_KEYS.has(key)) {
      unknownTokens.push(key);
      return raw;
    }
    const value = context[key];
    if (value == null || String(value).trim() === '') {
      missingTokens.push(key);
      return raw;
    }
    return escapeHtml(String(value));
  });
  TOKEN_PATTERN.lastIndex = 0;

  const dedupe = (arr) => [...new Set(arr)];
  return {
    rendered,
    unknownTokens: dedupe(unknownTokens),
    missingTokens: dedupe(missingTokens),
    ok: unknownTokens.length === 0 && missingTokens.length === 0,
  };
}

module.exports = {
  listBroadcastPlaceholders,
  extractBroadcastTemplateTokens,
  validateBroadcastTemplate,
  buildBroadcastTemplateContext,
  renderBroadcastTemplateStrict,
  ALLOWED_KEYS,
};
