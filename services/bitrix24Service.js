const config = require('../config/config');
const { buildBitrixCrmFields } = require('./bitrix24LeadMapper');

function normalizeWebhookBase(url) {
  const trimmed = String(url || '').trim();
  if (!trimmed) return '';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function isBitrixConfigured() {
  if (!config.bitrix24Enabled) return false;
  const base = normalizeWebhookBase(config.bitrix24WebhookUrl);
  return Boolean(base && /^https?:\/\//i.test(base));
}

function getBitrixMapperConfig() {
  return {
    entity: config.bitrix24Entity,
    assignedById: config.bitrix24AssignedById,
    sourceId: config.bitrix24SourceId,
    sourceDescription: config.bitrix24SourceDescription,
    dealCategoryId: config.bitrix24DealCategoryId,
    dealStageId: config.bitrix24DealStageId,
  };
}

function getRestMethod(entity) {
  return entity === 'deal' ? 'crm.deal.add' : 'crm.lead.add';
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
  if (!isBitrixConfigured()) {
    return { ok: false, reason: 'not_configured' };
  }

  const bitrixConfig = getBitrixMapperConfig();
  if (bitrixConfig.entity === 'deal') {
    const hasCategory = Number(bitrixConfig.dealCategoryId) > 0;
    const hasStage = Boolean(bitrixConfig.dealStageId);
    if (!hasCategory || !hasStage) {
      return {
        ok: false,
        reason: 'deal_config_incomplete',
        error: 'BITRIX24_DEAL_CATEGORY_ID and BITRIX24_DEAL_STAGE_ID are required when BITRIX24_ENTITY=deal',
      };
    }
  }

  const method = getRestMethod(bitrixConfig.entity);
  const url = `${normalizeWebhookBase(config.bitrix24WebhookUrl)}${method}.json`;
  const fields = buildBitrixCrmFields({
    fieldMap,
    leadData,
    connection,
    leadgenId,
    formId,
    bitrixConfig,
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

    const recordId = body.result;
    return {
      ok: true,
      bitrixId: recordId,
      entity: bitrixConfig.entity,
    };
  } catch (err) {
    return { ok: false, reason: 'network_error', error: err.message };
  }
}

module.exports = {
  normalizeWebhookBase,
  isBitrixConfigured,
  getBitrixMapperConfig,
  createCrmRecordFromLead,
};
