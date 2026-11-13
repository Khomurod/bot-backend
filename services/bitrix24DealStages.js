'use strict';

/**
 * Bitrix24 deals, as the hiring-stage proposals need them: find a candidate's
 * open deal, read the pipeline's stages, move a deal to one of them — and,
 * when the candidate has none, create the contact and the deal.
 *
 * Over the same inbound webhook as services/bitrix24Service.js (the URL is the
 * credential: it is never logged, and an error message carries Bitrix's own
 * words only). Every call is bounded by a timeout — a Bitrix that hangs must
 * not hold a queue lease or a button press open.
 *
 * Updates to an existing CRM record, each only after a person pressed a
 * button and the record was read again:
 *   - `crm.deal.update` STAGE_ID (`moveDealToStage`) — hiring's Move; the
 *     guarded Board sync may call it for STAGE_ID only after a live-schema
 *     validation, an exact before-stage re-read and a database idempotency
 *     claim;
 *   - `crm.deal.update` TITLE (`renameDeal`) — hiring's ✏️ Rename of a
 *     placeholder title ("No name"), only from services/hiringStages/rename.js;
 *   - `crm.contact.update` NAME / LAST_NAME (`renameContact`) — the same
 *     press, only for a contact whose own name is a placeholder.
 *
 * `crm.contact.add` and `crm.deal.add` create NEW records, and only from
 * services/hiringStages/crmCreate.js, after it has proved there is no open
 * deal and claimed the creation in the database. Each carries
 * ORIGINATOR_ID / ORIGIN_ID, so a retry after a timeout can find what an
 * unanswered call may have created before it ever adds again.
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
    throw new BitrixError('Bitrix24 is not connected (Settings → Bitrix24)', { reason: 'not_configured' });
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

/**
 * A `.get` of one record, or null when Bitrix says it does not exist. Bitrix
 * answers a deleted id with HTTP 400 "Not found" — a refusal like any other
 * to `call`, but to a reader it means "gone", not "Bitrix is broken".
 */
async function getOrNull(method, id, opts) {
  try {
    return await call(method, { id: Number(id) }, opts);
  } catch (err) {
    if (err instanceof BitrixError && !err.retryable && /\bnot found\b/i.test(err.message)) return null;
    throw err;
  }
}

/** One deal, or null when it no longer exists. */
async function getDeal(dealId, opts) {
  return mapDeal(await getOrNull('crm.deal.get', dealId, opts));
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

const ORIGINATOR = 'wenze_recruiting';

function phoneDigits(multifield) {
  return (Array.isArray(multifield) ? multifield : [])
    .map((p) => String(p?.VALUE || '').replace(/\D/g, '').slice(-10))
    .filter((d) => d.length === 10);
}

/** One contact, or null when it no longer exists. */
async function getContact(contactId, opts) {
  const r = await getOrNull('crm.contact.get', contactId, opts);
  if (!r || !r.ID) return null;
  return {
    id: Number(r.ID),
    first: r.NAME || '',
    last: r.LAST_NAME || '',
    name: [r.NAME, r.SECOND_NAME, r.LAST_NAME].filter(Boolean).join(' '),
    phones: phoneDigits(r.PHONE),
    originId: r.ORIGINATOR_ID === ORIGINATOR ? (r.ORIGIN_ID || null) : null,
  };
}

/**
 * Records this bot created under `originId` — checked on every row returned,
 * so a filter Bitrix did not apply can never pass for a match.
 */
async function findByOrigin(entity, originId, opts) {
  const rows = await call(`crm.${entity}.list`, {
    filter: { ORIGINATOR_ID: ORIGINATOR, ORIGIN_ID: String(originId) },
    select: ['ID', 'ORIGINATOR_ID', 'ORIGIN_ID', 'CLOSED'],
    order: { ID: 'ASC' },
  }, opts);
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r.ORIGINATOR_ID === ORIGINATOR && String(r.ORIGIN_ID) === String(originId))
    .map((r) => Number(r.ID))
    .filter((n) => n > 0);
}

function newId(result, what) {
  const id = Number(result);
  if (!Number.isInteger(id) || id <= 0) throw new BitrixError(`Bitrix did not return the new ${what}'s id`);
  return id;
}

/** A NEW contact. Only from services/hiringStages/crmCreate.js (see the header). */
async function createContact({
  first, last, phone, originId, assignedById = null, comments = '',
}, opts) {
  const fields = {
    NAME: first,
    LAST_NAME: last,
    PHONE: [{ VALUE: `+1${phone}`, VALUE_TYPE: 'WORK' }],
    OPENED: 'Y',
    ORIGINATOR_ID: ORIGINATOR,
    ORIGIN_ID: String(originId),
    COMMENTS: comments,
    ...(assignedById ? { ASSIGNED_BY_ID: Number(assignedById) } : {}),
  };
  return newId(await call('crm.contact.add', { fields, params: { REGISTER_SONET_EVENT: 'Y' } }, opts), 'contact');
}

/** A NEW deal for a contact. Only from services/hiringStages/crmCreate.js (see the header). */
async function createDeal({
  title, categoryId, stageId, contactId, originId, assignedById = null, comments = '',
}, opts) {
  const fields = {
    TITLE: title,
    CATEGORY_ID: Number(categoryId) || 0,
    STAGE_ID: String(stageId),
    CONTACT_ID: Number(contactId),
    OPENED: 'Y',
    ORIGINATOR_ID: ORIGINATOR,
    ORIGIN_ID: String(originId),
    COMMENTS: comments,
    ...(assignedById ? { ASSIGNED_BY_ID: Number(assignedById) } : {}),
  };
  return newId(await call('crm.deal.add', { fields, params: { REGISTER_SONET_EVENT: 'Y' } }, opts), 'deal');
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

/**
 * A deal's TITLE. Only from services/hiringStages/rename.js, after a person
 * pressed ✏️ Rename and the deal was read again (see the header).
 */
async function renameDeal(dealId, title, opts) {
  const ok = await call('crm.deal.update', {
    id: Number(dealId),
    fields: { TITLE: String(title) },
    params: { REGISTER_SONET_EVENT: 'Y' },
  }, opts);
  if (ok !== true) throw new BitrixError('Bitrix did not confirm the new title');
  return true;
}

/**
 * A contact's NAME and LAST_NAME — nothing else. Only from
 * services/hiringStages/rename.js, for a contact whose name was read again
 * and is still a placeholder (see the header).
 */
async function renameContact(contactId, { first, last }, opts) {
  const ok = await call('crm.contact.update', {
    id: Number(contactId),
    fields: { NAME: String(first), LAST_NAME: String(last) },
    params: { REGISTER_SONET_EVENT: 'Y' },
  }, opts);
  if (ok !== true) throw new BitrixError('Bitrix did not confirm the contact\'s new name');
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
  renameDeal,
  renameContact,
  getContact,
  findByOrigin,
  createContact,
  createDeal,
  ORIGINATOR,
  __mapDealForTests: mapDeal,
};
