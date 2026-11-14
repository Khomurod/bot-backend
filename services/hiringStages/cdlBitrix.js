'use strict';

/**
 * The Bitrix calls of the CDL reading (docs/architecture/hiring-cdl-reading.md),
 * over the same client and webhook as the rest of hiring
 * (services/bitrix24DealStages.js — which records every write in Monitoring →
 * Logs).
 *
 *   READ ONLY: `crm.contact.fields` / `crm.deal.fields` (the fields the owner
 *     may map, on demand from Settings and before each write, to know a
 *     field's type and list items), and `crm.contact.get` / `crm.deal.get`
 *     (which fields are already filled — those are never overwritten).
 *   WRITES, each with the caller's audit context (trigger `hiring_stage.cdl`,
 *     `valuesWithheld`: the entry keeps field names, never a CDL value):
 *     ONE `crm.contact.update` and ONE `crm.deal.update` with every field to
 *     set on that record, and ONE `crm.timeline.comment.add` on the deal.
 *     Only from services/hiringStages/cdlStep.js.
 */

const bitrix = require('../bitrix24DealStages');

/** The live field lists: `{contact, deal}`, each Bitrix's `crm.<entity>.fields` answer. */
async function readFieldLists(opts = {}) {
  const [contact, deal] = await Promise.all([
    bitrix.callBitrix('crm.contact.fields', {}, opts),
    bitrix.callBitrix('crm.deal.fields', {}, opts),
  ]);
  return { contact: contact || {}, deal: deal || {} };
}

/** A contact or deal with every field, or null when gone. */
function readRecord(entity, id, opts = {}) {
  return bitrix.getRawRecord(entity, id, opts);
}

/**
 * Set `fields` on one record, in one call. Only empty fields reach here
 * (lib/hiringStages/cdlWrite.js `planCdlWrite`).
 * @throws {BitrixError} refused, not answered, or not confirmed
 */
async function updateRecordFields(entity, id, fields, { audit, ...opts } = {}) {
  const params = { id: Number(id), fields, params: { REGISTER_SONET_EVENT: 'Y' } };
  const ok = entity === 'contact'
    ? await bitrix.callBitrix('crm.contact.update', params, { ...opts, audit })
    : await bitrix.callBitrix('crm.deal.update', params, { ...opts, audit });
  if (ok !== true) throw new bitrix.BitrixError(`Bitrix did not confirm the ${entity === 'contact' ? 'contact' : 'deal'} update`);
  return true;
}

/** The ONE timeline comment on the deal. @returns {Promise<number>} the comment's id */
async function addDealComment(dealId, comment, { audit, ...opts } = {}) {
  const id = await bitrix.callBitrix('crm.timeline.comment.add', {
    fields: { ENTITY_ID: Number(dealId), ENTITY_TYPE: 'deal', COMMENT: String(comment) },
  }, { ...opts, audit });
  if (!(Number(id) > 0)) throw new bitrix.BitrixError('Bitrix did not confirm the comment');
  return Number(id);
}

module.exports = {
  readFieldLists, readRecord, updateRecordFields, addDealComment,
};
