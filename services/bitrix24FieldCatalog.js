let catalogCache = null;
let catalogPromise = null;

function normalizeLabel(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

async function fetchLeadFieldCatalog(webhookBase, fetchImpl = fetch) {
  const base = String(webhookBase || '').trim().replace(/\/?$/, '/');
  if (!base) return null;

  const response = await fetchImpl(`${base}crm.lead.fields.json`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    throw new Error(body.error_description || body.error || `HTTP ${response.status}`);
  }
  return body.result || {};
}

async function fetchLeadStatuses(webhookBase, fetchImpl = fetch) {
  const base = String(webhookBase || '').trim().replace(/\/?$/, '/');
  if (!base) return [];

  const response = await fetchImpl(`${base}crm.status.list.json?filter[ENTITY_ID]=STATUS`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    throw new Error(body.error_description || body.error || `HTTP ${response.status}`);
  }
  return Array.isArray(body.result) ? body.result : [];
}

async function loadCatalog(webhookBase, fetchImpl = fetch) {
  if (catalogCache) return catalogCache;
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const [fields, statuses] = await Promise.all([
        fetchLeadFieldCatalog(webhookBase, fetchImpl),
        fetchLeadStatuses(webhookBase, fetchImpl),
      ]);
      catalogCache = { fields, statuses, loadedAt: Date.now() };
      return catalogCache;
    })().catch((err) => {
      catalogPromise = null;
      throw err;
    });
  }
  return catalogPromise;
}

function findFieldByTitleHints(fields, hints) {
  const normalizedHints = (hints || []).map(normalizeLabel).filter(Boolean);
  if (!normalizedHints.length) return null;

  for (const [name, meta] of Object.entries(fields || {})) {
    const title = normalizeLabel(meta?.listLabel || meta?.title || '');
    if (!title) continue;
    if (normalizedHints.every((hint) => title.includes(hint))) {
      return { name, meta };
    }
  }
  return null;
}

function findIncomingStatusId(statuses) {
  const list = Array.isArray(statuses) ? statuses : [];
  const incoming = list.find((s) => String(s.NAME || '').toUpperCase() === 'INCOMING')
    || list.find((s) => String(s.STATUS_ID || '').toUpperCase() === 'INCOMING')
    || list.find((s) => String(s.NAME || '').toUpperCase() === 'NEW');
  return incoming?.STATUS_ID || '';
}

function resolveEnumerationValue(meta, rawValue) {
  const value = String(rawValue || '').trim();
  if (!value || !meta?.items) return value;

  const normalized = value.toLowerCase();
  const match = meta.items.find((item) => {
    const itemValue = String(item.VALUE || '').trim().toLowerCase();
    return itemValue === normalized
      || (normalized === 'yes' && (itemValue === 'y' || itemValue === 'yes'))
      || (normalized === 'no' && (itemValue === 'n' || itemValue === 'no'));
  });
  return match ? match.ID : value;
}

function resetCatalogForTests() {
  catalogCache = null;
  catalogPromise = null;
}

module.exports = {
  loadCatalog,
  findFieldByTitleHints,
  findIncomingStatusId,
  resolveEnumerationValue,
  normalizeLabel,
  resetCatalogForTests,
};
