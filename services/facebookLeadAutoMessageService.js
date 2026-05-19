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

async function resolveAutoSmsForLead({ fieldMap, pageName, at = null } = {}) {
  const { settings, rules } = await loadAutoMessageConfig();

  if (!settings) {
    return {
      template: LEGACY_HARDCODED_TEMPLATE,
      ruleLabel: 'Legacy default',
      settings: {
        rep_name: 'Tom',
        company_name: 'Wenze trucking company',
        position_label: 'OTR position',
        is_enabled: true,
      },
      isEnabled: true,
    };
  }

  const picked = resolveTemplateAt({ settings, rules, at });
  return {
    ...picked,
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

  const context = buildTemplateContext({ fieldMap, settings, pageName });
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

module.exports = {
  LEGACY_HARDCODED_TEMPLATE,
  normalizeTimeString,
  timeToMinutes,
  isTimeInWindow,
  pickActiveRule,
  resolveTemplateAt,
  loadAutoMessageConfig,
  resolveAutoSmsForLead,
  previewAutoMessage,
  previewNow,
  previewTemplate,
  getTimezoneFriendlyName,
  validateAutoMessagePayload,
  serializeRuleForApi,
  serializeSettingsForApi,
};
