const { DateTime } = require('luxon');
const {
  buildTemplateContext,
  renderLeadSmsTemplate,
  validateTemplate,
  estimateSmsSegments,
} = require('./facebookLeadSmsTemplate');

const LEGACY_HARDCODED_TEMPLATE = (
  'Hello {first_name}, this is Tom with Wenze trucking company '
  + 'and thanks for applying to our OTR position. '
  + 'Can I call you right now to explain the details?'
);

function normalizeTimeString(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parts = raw.split(':');
  const hours = String(parts[0] || '0').padStart(2, '0');
  const minutes = String(parts[1] || '0').padStart(2, '0');
  return `${hours}:${minutes}`;
}

function timeToMinutes(timeStr) {
  const normalized = normalizeTimeString(timeStr);
  const [h, m] = normalized.split(':').map((v) => Number(v));
  return h * 60 + m;
}

function isTimeInWindow(localMinutes, startMinutes, endMinutes) {
  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) {
    return localMinutes >= startMinutes && localMinutes < endMinutes;
  }
  return localMinutes >= startMinutes || localMinutes < endMinutes;
}

function pickActiveRule(rules, atDateTime) {
  const weekday = atDateTime.weekday;
  const localMinutes = atDateTime.hour * 60 + atDateTime.minute;

  const sorted = [...(rules || [])]
    .filter((r) => r.is_active !== false)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id);

  for (const rule of sorted) {
    const days = Array.isArray(rule.days_of_week) ? rule.days_of_week.map(Number) : [];
    if (days.length && !days.includes(weekday)) continue;

    const start = timeToMinutes(rule.start_time_local);
    const end = timeToMinutes(rule.end_time_local);
    if (!isTimeInWindow(localMinutes, start, end)) continue;

    return rule;
  }
  return null;
}

function resolveTemplateAt({ settings, rules, at, ruleLabelHint = null }) {
  const timezone = String(settings?.timezone || 'America/Chicago').trim();
  const atDateTime = at
    ? DateTime.fromISO(String(at), { setZone: true }).setZone(timezone)
    : DateTime.now().setZone(timezone);

  const matchedRule = pickActiveRule(rules, atDateTime);
  if (matchedRule) {
    return {
      template: matchedRule.message_template,
      ruleLabel: ruleLabelHint || matchedRule.label || 'Scheduled rule',
      ruleId: matchedRule.id,
      source: 'rule',
      atIso: atDateTime.toISO(),
    };
  }

  return {
    template: settings?.fallback_template || LEGACY_HARDCODED_TEMPLATE,
    ruleLabel: 'Fallback (outside hours)',
    ruleId: null,
    source: 'fallback',
    atIso: atDateTime.toISO(),
  };
}

async function loadAutoMessageConfig() {
  try {
    const db = require('../database/db');
    return await db.getFacebookLeadAutoMessageSettings();
  } catch (err) {
    console.warn('[FB-LEAD-SMS] Could not load auto-message config:', err.message);
    return { settings: null, rules: [] };
  }
}

/**
 * The assigned recruiter's own opening line, or null.
 *
 * Null covers every "no override" case identically — no row, a blank template,
 * a parked one, no recruiter resolved at all, or a database hiccup. The caller
 * then uses the global time-based system exactly as it always did, which is
 * why a failure here can never cost a lead its text.
 */
async function loadRecruiterTemplate(recruiter) {
  const recruiterId = Number(recruiter?.id);
  if (!Number.isFinite(recruiterId) || recruiterId <= 0) return null;
  try {
    const db = require('../database/db');
    const row = await db.getFacebookLeadRecruiterMessage(recruiterId);
    const template = String(row?.message_template || '').trim();
    return template || null;
  } catch (err) {
    console.warn('[FB-LEAD-SMS] Could not load the recruiter auto-message:', err.message);
    return null;
  }
}

/**
 * Which message this lead gets, and whose name signs it.
 *
 * ORDER: the assigned recruiter's own template wins; failing that the global
 * time-based rules decide, then the outside-hours fallback, then the legacy
 * hard-coded line. `repName` rides along so `{rep_name}` renders as the person
 * whose RingCentral number is about to send it.
 *
 * The recruiter override deliberately does NOT carry its own schedule. The
 * master enable switch and the working-hours rules keep their existing meaning
 * for every lead; a recruiter template only replaces the WORDS.
 *
 * @param {object} params
 * @param {object} [params.recruiter]  the row resolved from the Bitrix assignee
 */
async function resolveAutoSmsForLead({ fieldMap, pageName, at = null, recruiter = null, config = null } = {}) {
  // `config` lets the caller hand in a configuration it has ALREADY loaded.
  // The processor reads it before resolving the Bitrix assignee — so a
  // deployment with auto-SMS switched off can skip the assignee poll entirely
  // — and re-reading it here would make that a second query per lead.
  const { settings, rules } = config || await loadAutoMessageConfig();
  const recruiterTemplate = await loadRecruiterTemplate(recruiter);
  const repName = String(recruiter?.name || '').trim();

  if (!settings) {
    return {
      template: recruiterTemplate || LEGACY_HARDCODED_TEMPLATE,
      ruleLabel: recruiterTemplate ? `${repName || 'Recruiter'}'s message` : 'Legacy default',
      source: recruiterTemplate ? 'recruiter' : 'legacy',
      recruiterId: recruiterTemplate ? recruiter.id : null,
      repName,
      settings: {
        rep_name: 'Tom',
        company_name: 'Wenze trucking company',
        position_label: 'OTR position',
        is_enabled: true,
      },
      isEnabled: true,
    };
  }

  const picked = recruiterTemplate
    ? {
      template: recruiterTemplate,
      ruleLabel: `${repName || 'Recruiter'}'s message`,
      ruleId: null,
      source: 'recruiter',
      atIso: null,
    }
    : resolveTemplateAt({ settings, rules, at });

  return {
    ...picked,
    recruiterId: recruiterTemplate ? recruiter.id : null,
    repName,
    settings,
    isEnabled: settings.is_enabled !== false,
  };
}

const TIMEZONE_FRIENDLY_NAMES = {
  'America/Chicago': 'Central Time',
  'America/New_York': 'Eastern Time',
  'America/Denver': 'Mountain Time',
  'America/Los_Angeles': 'Pacific Time',
  'America/Phoenix': 'Arizona Time',
  UTC: 'UTC',
};

function getTimezoneFriendlyName(timezone) {
  const tz = String(timezone || 'America/Chicago').trim();
  return TIMEZONE_FRIENDLY_NAMES[tz] || tz;
}

function previewAutoMessage({
  settings,
  rules,
  template = null,
  fieldMap = {},
  pageName = '',
  at = null,
  ruleLabel = null,
  // Who the preview should sign as. The recruiter section passes their name so
  // `{rep_name}` previews as the person who would actually be texting.
  repName = '',
}) {
  const timezone = String(settings?.timezone || 'America/Chicago').trim();
  const picked = template
    ? {
      template,
      ruleLabel: ruleLabel || 'Preview',
      source: 'template',
      atIso: at
        ? DateTime.fromISO(String(at), { setZone: true }).setZone(timezone).toISO()
        : null,
    }
    : resolveTemplateAt({ settings, rules, at });

  const context = buildTemplateContext({ fieldMap, settings, pageName, repName });
  const rendered = renderLeadSmsTemplate(picked.template, context);
  const segments = estimateSmsSegments(rendered);

  return {
    ...picked,
    rendered,
    context,
    segments,
    timezone,
    evaluated_at_iso: picked.atIso || null,
    timezone_friendly: getTimezoneFriendlyName(timezone),
  };
}

function previewNow({ settings, rules, fieldMap = {}, pageName = '', at = null }) {
  return previewAutoMessage({ settings, rules, fieldMap, pageName, at });
}

function previewTemplate({
  settings,
  template,
  fieldMap = {},
  pageName = '',
  ruleLabel = 'Preview',
}) {
  return previewAutoMessage({
    settings,
    rules: [],
    template,
    fieldMap,
    pageName,
    ruleLabel,
  });
}

function validateAutoMessagePayload({ settings, rules }) {
  const errors = [];

  if (!String(settings?.timezone || '').trim()) {
    errors.push('Timezone is required.');
  }

  const fallbackCheck = validateTemplate(settings?.fallback_template);
  if (!fallbackCheck.valid) {
    if (fallbackCheck.unknownTokens?.length) {
      errors.push(`Fallback message has unknown placeholders: ${fallbackCheck.unknownTokens.join(', ')}`);
    } else {
      errors.push(fallbackCheck.error || 'Fallback message is invalid.');
    }
  }

  for (const rule of rules || []) {
    const ruleCheck = validateTemplate(rule.message_template);
    if (!ruleCheck.valid) {
      const label = rule.label || 'Rule';
      if (ruleCheck.unknownTokens?.length) {
        errors.push(`${label}: unknown placeholders ${ruleCheck.unknownTokens.join(', ')}`);
      } else {
        errors.push(`${label}: ${ruleCheck.error || 'invalid template'}`);
      }
    }
    if (!Array.isArray(rule.days_of_week) || !rule.days_of_week.length) {
      errors.push(`${rule.label || 'Rule'}: select at least one day.`);
    }
  }

  return errors;
}

function serializeRuleForApi(rule) {
  return {
    id: rule.id,
    label: rule.label,
    days_of_week: rule.days_of_week,
    start_time_local: normalizeTimeString(rule.start_time_local),
    end_time_local: normalizeTimeString(rule.end_time_local),
    message_template: rule.message_template,
    sort_order: rule.sort_order,
    is_active: rule.is_active !== false,
  };
}

function serializeSettingsForApi(settings) {
  if (!settings) return null;
  return {
    id: settings.id,
    timezone: settings.timezone,
    is_enabled: settings.is_enabled !== false,
    rep_name: settings.rep_name,
    company_name: settings.company_name,
    position_label: settings.position_label,
    fallback_template: settings.fallback_template,
    updated_at: settings.updated_at,
  };
}

/**
 * Validate the recruiter section of a save. A BLANK template is valid and means
 * "no override" — that is how an admin removes one — so only non-blank text is
 * checked for unknown placeholders.
 */
function validateRecruiterMessagePayload(entries) {
  const errors = [];
  for (const entry of entries || []) {
    const template = String(entry?.message_template || '').trim();
    if (!template) continue;
    const check = validateTemplate(template);
    if (check.valid) continue;
    const who = entry?.recruiter_name || `Recruiter ${entry?.recruiter_id}`;
    if (check.unknownTokens?.length) {
      errors.push(`${who}: unknown placeholders ${check.unknownTokens.join(', ')}`);
    } else {
      errors.push(`${who}: ${check.error || 'invalid template'}`);
    }
  }
  return errors;
}

function serializeRecruiterMessageForApi(row) {
  return {
    recruiter_id: row.recruiter_id,
    recruiter_name: row.recruiter_name,
    active: row.recruiter_active !== false,
    bitrix_user_id: row.bitrix_user_id ?? null,
    message_template: row.message_template || '',
    is_enabled: row.is_enabled !== false,
    updated_at: row.updated_at || null,
  };
}

module.exports = {
  LEGACY_HARDCODED_TEMPLATE,
  normalizeTimeString,
  timeToMinutes,
  isTimeInWindow,
  pickActiveRule,
  resolveTemplateAt,
  loadAutoMessageConfig,
  loadRecruiterTemplate,
  resolveAutoSmsForLead,
  validateRecruiterMessagePayload,
  serializeRecruiterMessageForApi,
  previewAutoMessage,
  previewNow,
  previewTemplate,
  getTimezoneFriendlyName,
  validateAutoMessagePayload,
  serializeRuleForApi,
  serializeSettingsForApi,
};
