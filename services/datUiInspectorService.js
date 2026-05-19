const { callGroqRaw, GROQ_AI_MODEL } = require('./groqClient');

const DEFAULT_CONFIG = Object.freeze({
  toolbarMode: 'balanced',
  toolbarMaxWidth: 560,
  summaryDensity: 'full',
  contactLayout: 'stacked',
  contactMaxWidth: 132,
  compactButtons: false,
  hideCallWhenTight: false,
  reflowToolbarFields: false,
});

const TOOLBAR_MODES = new Set(['balanced', 'compact', 'wide']);
const SUMMARY_DENSITIES = new Set(['full', 'compact', 'hidden']);
const CONTACT_LAYOUTS = new Set(['stacked', 'row', 'offer_only']);

const INSPECTOR_SYSTEM_PROMPT = [
  'You are a UI tuning assistant for a lightweight Chrome extension injected into the DAT load board.',
  'You receive a compact JSON snapshot of the page after the extension renders.',
  'Your job is to improve alignment, reduce overflow, and keep the UI compact and native-looking.',
  'Return JSON only with keys: confidence, config, notes.',
  'config must only contain these keys:',
  'toolbarMode ("balanced"|"compact"|"wide"),',
  'toolbarMaxWidth (integer 320..640),',
  'summaryDensity ("full"|"compact"|"hidden"),',
  'contactLayout ("stacked"|"row"|"offer_only"),',
  'contactMaxWidth (integer 88..180),',
  'compactButtons (boolean),',
  'hideCallWhenTight (boolean),',
  'reflowToolbarFields (boolean).',
  'Rules:',
  '- Be conservative. Prefer the current/default layout unless the snapshot shows crowding or overflow.',
  '- If contact actions are overflowing narrow cells, prefer "offer_only" or "row".',
  '- If the toolbar is crowding the DAT search controls, prefer "compact" and/or reflowToolbarFields=true.',
  '- Never return selectors, CSS, HTML, JavaScript, markdown, or any extra keys.',
  '- notes must be a short array of plain strings.',
].join(' ');

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function clampFloat(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return Number(parsed.toFixed(2));
}

function takeEnum(value, allowed, fallback) {
  return allowed.has(String(value)) ? String(value) : fallback;
}

function stripCodeFences(text) {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function parseJsonObject(text) {
  const cleaned = stripCodeFences(text);
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_) {
    // fall through
  }

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_) {
      // noop
    }
  }

  return null;
}

function normalizeNotes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 5);
}

function normalizeInspectorConfig(rawConfig) {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  return {
    toolbarMode: takeEnum(raw.toolbarMode, TOOLBAR_MODES, DEFAULT_CONFIG.toolbarMode),
    toolbarMaxWidth: clampInt(raw.toolbarMaxWidth, 320, 640, DEFAULT_CONFIG.toolbarMaxWidth),
    summaryDensity: takeEnum(raw.summaryDensity, SUMMARY_DENSITIES, DEFAULT_CONFIG.summaryDensity),
    contactLayout: takeEnum(raw.contactLayout, CONTACT_LAYOUTS, DEFAULT_CONFIG.contactLayout),
    contactMaxWidth: clampInt(raw.contactMaxWidth, 88, 180, DEFAULT_CONFIG.contactMaxWidth),
    compactButtons: Boolean(raw.compactButtons),
    hideCallWhenTight: Boolean(raw.hideCallWhenTight),
    reflowToolbarFields: Boolean(raw.reflowToolbarFields),
  };
}

function normalizeInspectorResponse(rawText) {
  const parsed = parseJsonObject(rawText) || {};
  return {
    confidence: clampFloat(parsed.confidence, 0, 1, 0.42),
    config: normalizeInspectorConfig(parsed.config),
    notes: normalizeNotes(parsed.notes),
  };
}

function compactSnapshot(snapshot) {
  const safe = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const toolbar = safe.toolbar && typeof safe.toolbar === 'object' ? safe.toolbar : {};
  const contact = safe.contactActions && typeof safe.contactActions === 'object' ? safe.contactActions : {};
  const result = safe.resultSummary && typeof safe.resultSummary === 'object' ? safe.resultSummary : {};
  const currentConfig = safe.currentConfig && typeof safe.currentConfig === 'object' ? safe.currentConfig : null;

  return {
    pageType: String(safe.pageType || 'unknown').slice(0, 64),
    url: String(safe.url || '').slice(0, 240),
    signature: String(safe.signature || '').slice(0, 160),
    viewport: safe.viewport && typeof safe.viewport === 'object'
      ? {
          width: clampInt(safe.viewport.width, 0, 10000, 0),
          height: clampInt(safe.viewport.height, 0, 10000, 0),
        }
      : null,
    resultSummary: {
      rowCount: clampInt(result.rowCount, 0, 2000, 0),
      matched: clampInt(result.matched, 0, 2000, 0),
      partial: clampInt(result.partial, 0, 2000, 0),
      negotiate: clampInt(result.negotiate, 0, 2000, 0),
      fail: clampInt(result.fail, 0, 2000, 0),
      riskBrokers: clampInt(result.riskBrokers, 0, 2000, 0),
    },
    toolbar: {
      overflowX: clampInt(toolbar.overflowX, 0, 5000, 0),
      hostWidth: clampInt(toolbar.hostWidth, 0, 5000, 0),
      panelWidth: clampInt(toolbar.panelWidth, 0, 5000, 0),
      fieldCount: clampInt(toolbar.fieldCount, 0, 30, 0),
      controlCount: clampInt(toolbar.controlCount, 0, 50, 0),
      sampleControls: Array.isArray(toolbar.sampleControls)
        ? toolbar.sampleControls.slice(0, 8).map((item) => ({
            label: String(item?.label || '').slice(0, 40),
            width: clampInt(item?.width, 0, 3000, 0),
            kind: String(item?.kind || '').slice(0, 24),
          }))
        : [],
    },
    contactActions: {
      overflowCount: clampInt(contact.overflowCount, 0, 2000, 0),
      avgCellWidth: clampInt(contact.avgCellWidth, 0, 3000, 0),
      avgWrapWidth: clampInt(contact.avgWrapWidth, 0, 3000, 0),
      sample: Array.isArray(contact.sample)
        ? contact.sample.slice(0, 10).map((item) => ({
            cellWidth: clampInt(item?.cellWidth, 0, 3000, 0),
            wrapWidth: clampInt(item?.wrapWidth, 0, 3000, 0),
            overflowX: clampInt(item?.overflowX, 0, 1000, 0),
            overflowY: clampInt(item?.overflowY, 0, 1000, 0),
            childCount: clampInt(item?.childCount, 0, 10, 0),
            labels: Array.isArray(item?.labels)
              ? item.labels.slice(0, 4).map((label) => String(label || '').slice(0, 24))
              : [],
          }))
        : [],
    },
    currentConfig: currentConfig ? normalizeInspectorConfig(currentConfig) : null,
  };
}

function buildInspectorPrompt(snapshot) {
  return JSON.stringify({
    task: 'Choose the most stable bounded UI config for the DAT extension.',
    defaults: DEFAULT_CONFIG,
    snapshot,
  });
}

async function inspectDatPageLayout(snapshot) {
  const compact = compactSnapshot(snapshot);
  const raw = await callGroqRaw(buildInspectorPrompt(compact), {
    systemText: INSPECTOR_SYSTEM_PROMPT,
    temperature: 0.15,
    maxTokens: 900,
    model: GROQ_AI_MODEL,
  });

  const normalized = normalizeInspectorResponse(raw);
  return {
    ...normalized,
    signature: compact.signature || null,
    inspectedAt: new Date().toISOString(),
    model: GROQ_AI_MODEL,
  };
}

module.exports = {
  DEFAULT_CONFIG,
  TOOLBAR_MODES,
  SUMMARY_DENSITIES,
  CONTACT_LAYOUTS,
  INSPECTOR_SYSTEM_PROMPT,
  compactSnapshot,
  normalizeInspectorConfig,
  normalizeInspectorResponse,
  inspectDatPageLayout,
};
