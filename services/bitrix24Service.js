/**
 * Bitrix24 CRM client for Facebook leads.
 *
 * Two jobs, in this order, both over the account's INBOUND webhook URL (the
 * secret is the URL, so it never appears in a header or a log line):
 *
 *   1. create the lead/deal          → createCrmRecordFromLead()
 *   2. read back who owns it now     → getCrmRecordAssignee() / waitForCrmAssignee()
 *
 * Step 2 exists because Bitrix assigns the responsible person ASYNCHRONOUSLY.
 * `crm.lead.add` returns an id, not an owner: a distribution rule (queue,
 * round-robin) reassigns the record moments later. The lead auto-SMS has to
 * know who owns it to text from that person's own number, so it asks again
 * after a short, bounded wait rather than trusting the value at creation.
 *
 * CONFIGURATION IS READ AT CALL TIME, NOT AT LOAD TIME. It comes from
 * database/bitrix.js — the row an operator edits in Settings → RingCentral →
 * Bitrix24, falling back to BITRIX24_* env vars for anything never saved — so
 * every entry point here is async and nothing caches a webhook URL in a
 * module-scope constant. The field map alone stays file/env-based
 * (config.bitrix24FieldMap).
 *
 * Read-only and best-effort throughout: a Bitrix outage degrades the sender
 * choice back to the shared number, it never blocks the lead.
 */
const config = require('../config/config');
const { getBitrixConfig } = require('../database/bitrix');
const { buildBitrixCrmFields } = require('./bitrix24LeadMapper');
const { loadCatalog } = require('./bitrix24FieldCatalog');

function normalizeWebhookBase(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

/** The effective settings plus the (file-based) field map. */
async function getBitrixRuntimeConfig() {
  const cfg = await getBitrixConfig();
  return { ...cfg, fieldMap: config.bitrix24FieldMap };
}

/** The webhook base URL to call, or '' when none is set. Never log it. */
async function getWebhookBase() {
  const cfg = await getBitrixConfig();
  return normalizeWebhookBase(cfg.webhookUrl);
}

async function isBitrixConfigured() {
  const cfg = await getBitrixConfig();
  if (!cfg.enabled) return false;
  const base = normalizeWebhookBase(cfg.webhookUrl);
  return Boolean(base && /^https?:\/\//i.test(base));
}

async function getBitrixMapperConfig() {
  const cfg = await getBitrixRuntimeConfig();
  return {
    entity: cfg.entity,
    assignedById: cfg.assignedById,
    sourceId: cfg.sourceId,
    sourceDescription: cfg.sourceDescription,
    dealCategoryId: cfg.dealCategoryId,
    dealStageId: cfg.dealStageId,
    fieldMap: cfg.fieldMap,
  };
}

async function loadBitrixFieldCatalog(fetchImpl = fetch) {
  const base = await getWebhookBase();
  if (!base) return null;
  try {
    return await loadCatalog(base, fetchImpl);
  } catch (err) {
    console.warn('[Bitrix24] Field catalog unavailable:', err.message);
    return null;
  }
}

function getRestMethod(entity) {
  return entity === 'deal' ? 'crm.deal.add' : 'crm.lead.add';
}

function getReadMethod(entity) {
  return entity === 'deal' ? 'crm.deal.get' : 'crm.lead.get';
}

/**
 * How often to re-ask Bitrix who owns a new record, and for how long. The total
 * budget is the "assignee wait" setting (default 25s) — long enough for a
 * distribution rule to run, short enough that a driver's text is not late.
 * 0 disables waiting entirely: one read, then whatever Bitrix said.
 */
const ASSIGNEE_POLL_INTERVAL_MS = 5000;

async function assigneeAttempts() {
  const cfg = await getBitrixConfig();
  const budget = Math.max(0, Number(cfg.assigneeWaitMs) || 0);
  return 1 + Math.floor(budget / ASSIGNEE_POLL_INTERVAL_MS);
}

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
}

/**
 * @param {object} params
 * @param {Record<string, string>} params.fieldMap
 * @param {object} params.leadData
 * @param {object} params.connection
 * @param {string} params.leadgenId
 * @param {string} [params.formId]
 * @param {typeof fetch} [params.fetchImpl]
 */
async function createCrmRecordFromLead({
  fieldMap,
  leadData,
  connection,
  leadgenId,
  formId = '',
  fetchImpl = fetch,
}) {
  if (!(await isBitrixConfigured())) {
    return { ok: false, reason: 'not_configured' };
  }

  const bitrixConfig = await getBitrixMapperConfig();
  if (bitrixConfig.entity === 'deal') {
    const hasCategory = Number(bitrixConfig.dealCategoryId) > 0;
    const hasStage = Boolean(bitrixConfig.dealStageId);
    if (!hasCategory || !hasStage) {
      return {
        ok: false,
        reason: 'deal_config_incomplete',
        error: 'A deal category and stage are required when the entity is "deal" — set them in Settings → RingCentral → Bitrix24.',
      };
    }
  }

  const method = getRestMethod(bitrixConfig.entity);
  const url = `${await getWebhookBase()}${method}.json`;
  const catalog = bitrixConfig.entity === 'lead'
    ? await loadBitrixFieldCatalog(fetchImpl)
    : null;
  const fields = buildBitrixCrmFields({
    fieldMap,
    leadData,
    connection,
    leadgenId,
    formId,
    bitrixConfig,
    catalog,
  });

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      const message = body.error_description || body.error || `HTTP ${response.status}`;
      return { ok: false, reason: 'api_error', error: String(message) };
    }

    return { ok: true, bitrixId: body.result, entity: bitrixConfig.entity };
  } catch (err) {
    return { ok: false, reason: 'network_error', error: err.message };
  }
}

/**
 * Who owns a Bitrix record right now.
 *
 * @returns {Promise<{ok: boolean, assignedById: number|null, reason?: string,
 *   error?: string}>} `assignedById` is null when Bitrix reports no owner.
 */
async function getCrmRecordAssignee({ bitrixId, entity, fetchImpl = fetch }) {
  if (!(await isBitrixConfigured())) return { ok: false, assignedById: null, reason: 'not_configured' };

  const id = Number(bitrixId);
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, assignedById: null, reason: 'invalid_id' };
  }

  const resolvedEntity = entity || (await getBitrixMapperConfig()).entity;
  const base = await getWebhookBase();
  const url = `${base}${getReadMethod(resolvedEntity)}.json?id=${encodeURIComponent(String(id))}`;

  try {
    const response = await fetchImpl(url, { method: 'GET' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
      const message = body.error_description || body.error || `HTTP ${response.status}`;
      return { ok: false, assignedById: null, reason: 'api_error', error: String(message) };
    }
    // Bitrix returns every field as a string, ASSIGNED_BY_ID included.
    const assignedById = Number(body?.result?.ASSIGNED_BY_ID);
    return {
      ok: true,
      assignedById: Number.isFinite(assignedById) && assignedById > 0 ? assignedById : null,
    };
  } catch (err) {
    return { ok: false, assignedById: null, reason: 'network_error', error: err.message };
  }
}

/**
 * Poll for the record's assignee until `isAcceptable` says the answer is usable
 * or the attempt budget runs out.
 *
 * The first read happens immediately, so a lead that is already assigned to a
 * mapped recruiter costs one request and no delay. Only an unmapped or missing
 * owner waits — that is the case where a distribution rule is still running.
 *
 * `isAcceptable` decides, because "usable" is the caller's business: the SMS
 * sender needs an assignee that maps to a recruiter who can actually send.
 *
 * @param {object} params
 * @param {number|string} params.bitrixId
 * @param {string} [params.entity]                'lead' | 'deal'
 * @param {(assignedById: number|null) => boolean|Promise<boolean>} [params.isAcceptable]
 * @param {number} [params.attempts]              total reads, including the first;
 *                                                defaults to the configured wait budget
 * @param {number} [params.intervalMs]            wait between reads
 * @param {(ms:number)=>Promise<void>} [params.sleep]  injected for tests
 * @param {typeof fetch} [params.fetchImpl]
 * @returns {Promise<{assignedById:number|null, accepted:boolean, attempts:number,
 *   reason?:string, error?:string}>}
 */
async function waitForCrmAssignee({
  bitrixId,
  entity,
  isAcceptable = (assignedById) => assignedById != null,
  attempts,
  intervalMs = ASSIGNEE_POLL_INTERVAL_MS,
  sleep = defaultSleep,
  fetchImpl = fetch,
}) {
  const total = Math.max(1, Number(attempts ?? await assigneeAttempts()) || 1);
  let last = { ok: false, assignedById: null, reason: 'not_attempted' };

  for (let attempt = 1; attempt <= total; attempt += 1) {
    if (attempt > 1) await sleep(Math.max(0, Number(intervalMs) || 0));
    last = await getCrmRecordAssignee({ bitrixId, entity, fetchImpl });
    // A configuration or id problem will not fix itself by asking again.
    if (!last.ok && (last.reason === 'not_configured' || last.reason === 'invalid_id')) {
      return { assignedById: null, accepted: false, attempts: attempt, reason: last.reason };
    }
    if (last.ok && await isAcceptable(last.assignedById)) {
      return { assignedById: last.assignedById, accepted: true, attempts: attempt };
    }
  }

  return {
    assignedById: last.ok ? last.assignedById : null,
    accepted: false,
    attempts: total,
    reason: last.ok ? 'not_acceptable' : last.reason,
    error: last.error,
  };
}

module.exports = {
  normalizeWebhookBase,
  getBitrixRuntimeConfig,
  getWebhookBase,
  isBitrixConfigured,
  getBitrixMapperConfig,
  loadBitrixFieldCatalog,
  createCrmRecordFromLead,
  getCrmRecordAssignee,
  waitForCrmAssignee,
  assigneeAttempts,
  ASSIGNEE_POLL_INTERVAL_MS,
};
