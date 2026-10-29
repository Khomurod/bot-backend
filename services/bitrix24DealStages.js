'use strict';

/**
 * Bitrix24 deals, as the hiring-stage proposals need them: find a candidate's
 * open deal, read the pipeline's stages, move a deal to one of them.
 *
 * Over the same inbound webhook as services/bitrix24Service.js (the URL is the
 * credential: it is never logged, and an error message carries Bitrix's own
 * words only). Every call is bounded by a timeout — a Bitrix that hangs must
 * not hold a queue lease or a button press open.
 *
 * `crm.deal.update` IS THE ONLY WRITE, and only services/hiringStages/actions.js
 * calls it, after a person pressed the button. `callBitrix` is exported for
 * readers (services/homeTime/violationAlerts.js), which never write.
 *
 * A failure THROWS `BitrixError` (with `.retryable` for a network failure or a
 * 5xx). The callers decide: the reviewer tries again later, a button press
 * tells the person.
 */

const { getBitrixConfig } = require('../database/bitrix');
const { normalizeWebhookBase } = require('./bitrix24Service');

const TIMEOUT_MS = 15_000;
/** Contacts or deals looked at per search: a name matching more than this is not a match. */
const MAX_ROWS = 10;

class BitrixError extends Error {
  constructor(message, { retryable = false, reason = 'api_error' } = {}) {
    super(message);
    this.name = 'BitrixError';
    this.retryable = retryable;
    this.reason = reason;
  }
}

async function webhookBase() {
  const cfg = await getBitrixConfig();
  const base = normalizeWebhookBase(cfg.webhookUrl);
  if (!cfg.enabled || !/^https?:\/\//i.test(base)) {
    throw new BitrixError('Bitrix24 is not connected (Settings → RingCentral → Bitrix24)', { reason: 'not_configured' });
  }
  return base;
}

/**
 * The portal's address — the origin only, never the webhook's credential path
 * — or null when Bitrix is not connected. For links a person can open.
 */
async function portalOrigin() {
  try {
    return new URL(await webhookBase()).origin;
  } catch {
    return null;
  }
}

/** A deal's page on a known portal — the one place the link's shape lives. */
function dealUrlFor(origin, dealId) {
  return origin ? `${origin}/crm/deal/details/${Number(dealId)}/` : null;
}

/** A smart-process item's page (e.g. a truck in "Trucks", entityTypeId 1040). */
function itemUrlFor(origin, entityTypeId, itemId) {
  return origin ? `${origin}/crm/type/${Number(entityTypeId)}/details/${Number(itemId)}/` : null;
}

/** The portal's address, for a link to a deal a person can open. */
async function dealUrl(dealId) {
  return dealUrlFor(await portalOrigin(), dealId);
}

async function call(method, params, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const base = await webhookBase();
  let response;
  try {
    response = await fetchImpl(`${base}${method}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    throw new BitrixError(timedOut ? `Bitrix did not answer ${method} in ${timeoutMs}ms` : `Bitrix unreachable (${err.message})`,
      { retryable: true, reason: 'network_error' });
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    const words = String(body.error_description || body.error || `HTTP ${response.status}`).slice(0, 200);
    throw new BitrixError(`Bitrix ${method}: ${words}`, { retryable: response.status >= 500 || response.status === 429 });
  }
  return body.result;
}

const DEAL_FIELDS = ['ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', 'CONTACT_ID', 'ASSIGNED_BY_ID', 'CLOSED', 'DATE_MODIFY'];

function mapDeal(row) {
  if (!row || !row.ID) return null;
  return {
    id: Number(row.ID),
    title: row.TITLE || null,
    stageId: row.STAGE_ID || null,
    categoryId: String(row.CATEGORY_ID ?? '0'),
    contactId: row.CONTACT_ID ? Number(row.CONTACT_ID) : null,
    closed: row.CLOSED === 'Y',
    modifiedAt: row.DATE_MODIFY || null,
  };
}

/** Contact ids holding any of these phone numbers (ten digits each). */
async function findContactIdsByPhone(phones, opts) {
  const values = phones.flatMap((p) => [`+1${p}`, p]).slice(0, 20);
  if (!values.length) return [];
  const result = await call('crm.duplicate.findbycomm', { type: 'PHONE', values, entity_type: 'CONTACT' }, opts);
  const ids = Array.isArray(result?.CONTACT) ? result.CONTACT : [];
  return [...new Set(ids.map(Number).filter((n) => n > 0))].slice(0, MAX_ROWS);
}

/** Contacts whose last name contains `word` — the caller checks the whole name. */
async function listContactsByLastName(word, opts) {
  const rows = await call('crm.contact.list', {
    filter: { '%LAST_NAME': word },
    select: ['ID', 'NAME', 'SECOND_NAME', 'LAST_NAME'],
    order: { ID: 'DESC' },
  }, opts);
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_ROWS + 1).map((r) => ({
    id: Number(r.ID),
    name: [r.NAME, r.SECOND_NAME, r.LAST_NAME].filter(Boolean).join(' '),
    first: r.NAME || '',
    last: r.LAST_NAME || '',
  }));
}

/** Open deals whose primary contact is this one, newest change first. */
async function listOpenDealsForContact(contactId, opts) {
  const rows = await call('crm.deal.list', {
    filter: { CONTACT_ID: Number(contactId), CLOSED: 'N' },
    select: DEAL_FIELDS,
    order: { DATE_MODIFY: 'DESC' },
  }, opts);
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_ROWS).map(mapDeal).filter(Boolean);
}

/** Open deals whose title contains `word` (a lead's deal is "Facebook Lead – First Last"). */
async function listOpenDealsByTitle(word, opts) {
  const rows = await call('crm.deal.list', {
    filter: { '%TITLE': word, CLOSED: 'N' },
    select: DEAL_FIELDS,
    order: { DATE_MODIFY: 'DESC' },
  }, opts);
  return (Array.isArray(rows) ? rows : []).slice(0, MAX_ROWS + 1).map(mapDeal).filter(Boolean);
}

async function getDeal(dealId, opts) {
  return mapDeal(await call('crm.deal.get', { id: Number(dealId) }, opts));
}

/** The stages of one pipeline (category 0 is the default one), as Bitrix rows. */
async function listStageRows(categoryId, opts) {
  const id = Number(categoryId) || 0;
  const rows = await call('crm.status.list', {
    filter: { ENTITY_ID: id ? `DEAL_STAGE_${id}` : 'DEAL_STAGE' },
    order: { SORT: 'ASC' },
  }, opts);
  return Array.isArray(rows) ? rows : [];
}

/** THE WRITE. Only after a person confirmed (see the header). */
async function moveDealToStage(dealId, stageId, opts) {
  const ok = await call('crm.deal.update', {
    id: Number(dealId),
    fields: { STAGE_ID: String(stageId) },
    params: { REGISTER_SONET_EVENT: 'Y' },
  }, opts);
  if (ok !== true) throw new BitrixError('Bitrix did not confirm the stage change');
  return true;
}

module.exports = {
  BitrixError,
  // The bounded call itself, for a reader with its own field list (the
  // home-time violation alerts read pipeline 33's own fields). Reads only.
  callBitrix: call,
  TIMEOUT_MS,
  MAX_ROWS,
  portalOrigin,
  dealUrlFor,
  itemUrlFor,
  dealUrl,
  findContactIdsByPhone,
  listContactsByLastName,
  listOpenDealsForContact,
  listOpenDealsByTitle,
  getDeal,
  listStageRows,
  moveDealToStage,
  __mapDealForTests: mapDeal,
};
