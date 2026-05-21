const fs = require('fs');
const path = require('path');

const DEFAULT_MAP_PATH = path.join(__dirname, '..', 'config', 'bitrix24LeadFieldMap.json');

function deepMerge(target, source) {
  const out = { ...target };
  for (const [key, value] of Object.entries(source || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(out[key] || {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function loadJsonFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function parseEnvJson(name) {
  const raw = String(process.env[name] || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[Bitrix24] Invalid JSON in ${name}:`, err.message);
    return null;
  }
}

function loadBitrixFieldMapConfig() {
  const fromFile = loadJsonFile(DEFAULT_MAP_PATH) || {
    defaults: {},
    custom: {},
    byFormId: {},
    statusId: '',
    enumerations: {},
  };

  const envMap = parseEnvJson('BITRIX24_FIELD_MAP');
  const envByForm = parseEnvJson('BITRIX24_FIELD_MAP_BY_FORM_ID');

  return {
    defaults: { ...fromFile.defaults, ...(envMap?.defaults || {}) },
    custom: { ...fromFile.custom, ...(envMap?.custom || {}) },
    byFormId: { ...fromFile.byFormId, ...(envByForm || {}) },
    statusId: String(envMap?.statusId || fromFile.statusId || process.env.BITRIX24_STATUS_ID || '').trim(),
    enumerations: { ...fromFile.enumerations, ...(envMap?.enumerations || {}) },
  };
}

function resolveFieldMapConfig(formId) {
  const base = loadBitrixFieldMapConfig();
  const formKey = String(formId || '').trim();
  const formOverrides = formKey ? base.byFormId[formKey] : null;

  return {
    defaults: deepMerge(base.defaults, formOverrides?.defaults || {}),
    custom: { ...base.custom, ...(formOverrides?.custom || {}) },
    statusId: String(formOverrides?.statusId || base.statusId || '').trim(),
    enumerations: { ...base.enumerations, ...(formOverrides?.enumerations || {}) },
  };
}

module.exports = {
  loadBitrixFieldMapConfig,
  resolveFieldMapConfig,
  DEFAULT_MAP_PATH,
};
