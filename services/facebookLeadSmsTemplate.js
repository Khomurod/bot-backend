const PLACEHOLDER_DEFS = [
  { key: 'first_name', label: 'First name', description: 'Lead first name', example: 'Jane' },
  { key: 'last_name', label: 'Last name', description: 'Lead last name', example: 'Doe' },
  { key: 'full_name', label: 'Full name', description: 'Lead full name', example: 'Jane Doe' },
  { key: 'phone', label: 'Phone', description: 'Lead phone number', example: '+15551234567' },
  { key: 'email', label: 'Email', description: 'Lead email', example: 'jane@example.com' },
  { key: 'city', label: 'City', description: 'Lead city', example: 'Chicago' },
  { key: 'state', label: 'State', description: 'Lead state', example: 'IL' },
  { key: 'zip_code', label: 'ZIP', description: 'Lead ZIP code', example: '60601' },
  { key: 'country', label: 'Country', description: 'Lead country', example: 'US' },
  { key: 'rep_name', label: 'Rep name', description: 'The recruiter Bitrix assigned the lead to; the Rep name in settings when nobody could be resolved', example: 'Sofia' },
  { key: 'company_name', label: 'Company', description: 'From settings', example: 'Wenze trucking company' },
  { key: 'position', label: 'Position', description: 'From settings (position label)', example: 'OTR position' },
  { key: 'page_name', label: 'Facebook Page', description: 'Connected Page name', example: 'WENZE Transport' },
];

const ALLOWED_KEYS = new Set(PLACEHOLDER_DEFS.map((p) => p.key));
const TOKEN_PATTERN = /\{([a-z][a-z0-9_]*)\}/gi;

function listPlaceholders() {
  return PLACEHOLDER_DEFS.map((p) => ({ ...p }));
}

function parseNameParts(fieldMap = {}) {
  const fullName = String(fieldMap.full_name || fieldMap.first_name || '').trim();
  const parts = fullName.split(/\s+/).filter(Boolean);
  const firstName = String(fieldMap.first_name || parts[0] || '').trim() || 'Driver';
  const lastName = String(fieldMap.last_name || (parts.length > 1 ? parts.slice(1).join(' ') : '')).trim();
  const resolvedFull = fullName || [firstName, lastName].filter(Boolean).join(' ') || 'Driver';
  return { firstName, lastName, fullName: resolvedFull };
}

/**
 * @param {object} params
 * @param {object} [params.fieldMap]  the lead's Facebook fields
 * @param {object} [params.settings]  the auto-message settings row
 * @param {string} [params.pageName]
 * @param {string} [params.repName]
 *   WHOSE LEAD THIS IS — the recruiter Bitrix assigned it to, when one was
 *   resolved. Empty falls back to the generic sender in `settings`.
 *
 *   Deliberately NOT "whose number sent it". When Sofia is the assignee but
 *   her RingCentral send fails and the text goes out on the shared number, the
 *   driver still reads "this is Sofia" — because the lead is still Sofia's,
 *   she is the one who will call, and a message signed "Tom" would leave the
 *   driver hearing from one person and called by another. The operator is told
 *   separately: the Telegram thread carries the sender fallback note. The
 *   settings rep name is for the case where nobody was resolved at all, and
 *   nobody in particular is therefore texting.
 */
function buildTemplateContext({ fieldMap = {}, settings = {}, pageName = '', repName = '' } = {}) {
  const { firstName, lastName, fullName } = parseNameParts(fieldMap);
  return {
    first_name: firstName,
    last_name: lastName,
    full_name: fullName,
    phone: String(fieldMap.phone_number || fieldMap.phone || '').trim(),
    email: String(fieldMap.email || '').trim(),
    city: String(fieldMap.city || '').trim(),
    state: String(fieldMap.state || '').trim(),
    zip_code: String(fieldMap.zip_code || '').trim(),
    country: String(fieldMap.country || '').trim(),
    rep_name: String(repName || settings.rep_name || 'Tom').trim(),
    company_name: String(settings.company_name || 'Wenze trucking company').trim(),
    position: String(settings.position_label || settings.position || 'OTR position').trim(),
    page_name: String(pageName || '').trim(),
  };
}

function renderLeadSmsTemplate(template, context = {}) {
  const text = String(template || '');
  return text.replace(TOKEN_PATTERN, (match, key) => {
    const value = context[key];
    if (value == null || value === '') return '';
    return String(value);
  }).replace(/\s{2,}/g, ' ').trim();
}

function extractTemplateTokens(template) {
  const tokens = new Set();
  const text = String(template || '');
  let match = TOKEN_PATTERN.exec(text);
  while (match) {
    tokens.add(match[1].toLowerCase());
    match = TOKEN_PATTERN.exec(text);
  }
  TOKEN_PATTERN.lastIndex = 0;
  return [...tokens];
}

function validateTemplate(template) {
  const unknown = extractTemplateTokens(template).filter((t) => !ALLOWED_KEYS.has(t));
  if (unknown.length) {
    return { valid: false, unknownTokens: unknown };
  }
  if (!String(template || '').trim()) {
    return { valid: false, error: 'Template cannot be empty.' };
  }
  return { valid: true, unknownTokens: [] };
}

function estimateSmsSegments(text) {
  const len = String(text || '').length;
  if (len === 0) return { length: 0, segments: 0 };
  const singleLimit = 160;
  const multiLimit = 153;
  const segments = len <= singleLimit ? 1 : Math.ceil(len / multiLimit);
  return { length: len, segments };
}

module.exports = {
  listPlaceholders,
  buildTemplateContext,
  renderLeadSmsTemplate,
  extractTemplateTokens,
  validateTemplate,
  estimateSmsSegments,
  ALLOWED_KEYS,
};
