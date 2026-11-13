'use strict';

/**
 * Creating a candidate's Bitrix contact and deal when the conversation has
 * identified them for certain and Bitrix has no open deal (owner, November
 * 2026: twenty "please create the deal" requests had gone unanswered).
 *
 *   claim the creation (database/hiringStages/crmRecords.js)
 *     → CONTACT: the one holding this phone, if its name is the post's —
 *       several holding it, or another person's name on it, or this name on a
 *       contact under another phone: nothing is created (`blocked`), a person
 *       is asked; none at all: a NEW contact
 *     → DEAL: that contact's open deal if one appeared meanwhile; else a NEW
 *       deal at "Sent to Safety" (startStage)
 *     → `created` — and the reviewer proposes the stage move as usual: a
 *       person still presses Move.
 *
 * NEVER TWICE. Every step is recorded BEFORE its Bitrix call. A call that got
 * no answer (a timeout) leaves the record at `creating_contact` /
 * `creating_deal`; the retry — a minute or more later — searches Bitrix by
 * phone, by the contact's deals and by the ORIGIN_ID the bot stamps on what
 * it creates, and adds only when that finds nothing. A second post of the
 * same driver waits (`busy`) while the first is creating. A conversation the
 * bot already created for is never created for again.
 *
 * THE NAME WRITTEN is the identity's DISPLAY name (lib/hiringStages/
 * displayName.js: the post's words in Safety's spelling and order), stored on
 * the claim — a creation resumed after a timeout writes the name it started
 * with. The name a contact is FOUND by stays the post's.
 *
 * Only ever called with lib/hiringStages/identity.js's certain identity. The
 * only Bitrix writes here are `crm.contact.add` and `crm.deal.add`.
 */

const records = require('../../database/hiringStages/crmRecords');
const bitrix = require('../bitrix24DealStages');
const { getBitrixConfig } = require('../../database/bitrix');
const { postLink } = require('../../lib/safetyApprovals/announcement');
const { nameParts, stageByName } = require('../../lib/hiringStages/proposal');
const { splitName } = require('../../lib/hiringStages/identity');
const { findContactsByName, contactMatches } = require('./dealFinder');

const IN_FLIGHT = ['claimed', 'creating_contact', 'creating_deal'];

const originOf = (chatId, rootMessageId) => `tg:${chatId}:${Number(rootMessageId)}`;

/**
 * Where a new deal starts: "Sent to Safety" (owner, 11 November 2026). A
 * candidate posted in the recruiting group IS a candidate sent to Safety, and
 * Bitrix's own automation carries a deal from that stage into the Safety
 * pipeline — so the next step is asked there, never "Hired" from New Lead.
 * A pipeline without that stage creates nothing (a person is asked).
 */
const START_STAGE_NAME = 'Sent to Safety';

function startStage(stages) {
  return stageByName(stages || [], START_STAGE_NAME);
}

/** The display name (and its NAME / LAST_NAME) a claim holds, or the identity's own. */
function writtenName(record, identity) {
  const displayName = record.displayName || identity.displayName || identity.name;
  const split = splitName(displayName);
  return split ? { displayName, first: split.first, last: split.last }
    : { displayName: identity.name, first: identity.first, last: identity.last };
}

const newestFirst = (a, b) => String(b.modifiedAt || '').localeCompare(String(a.modifiedAt || '')) || b.id - a.id;

async function block(record, reason) {
  await records.advance(record.id, IN_FLIGHT, 'blocked', { error: reason });
  return { status: 'blocked', reason };
}

/**
 * Why the bot created a record, for Monitoring → Logs: automatic, from the
 * recruiting group's conversation (its chat and post are the evidence). The
 * name is the label and the title's `to` — both taken out after 60 days. No
 * phone: the contact's number is never shown.
 */
function createAudit(record, what, name, deal = null) {
  return {
    actorKind: 'automatic',
    trigger: 'hiring_stage.create',
    reason: what === 'deal'
      ? 'The recruiting group\'s conversation identified the candidate for certain and Bitrix had no open deal.'
      : 'The recruiting group\'s conversation identified the candidate for certain and Bitrix had no contact for them.',
    evidence: {
      chatId: record.chatId, rootMessageId: record.rootMessageId, crmRecordId: record.id,
      ...(deal ? { contactId: deal.contactId } : {}),
    },
    targetLabel: name || null,
    change: deal
      ? [{ field: 'TITLE', from: null, to: name }, { field: 'STAGE_ID', from: null, to: `${deal.stage.name} (${deal.stage.id})` },
        { field: 'CATEGORY_ID', from: null, to: String(deal.categoryId) }]
      : [{ field: 'NAME', from: null, to: name }],
    correlationKey: `hiring_create:${record.id}`,
  };
}

/** The contact to put the deal on: `{contactId, reused}`, or `{blocked}`. */
async function resolveContact(record, identity, { origin, fields }, opts) {
  if (record.contactId) return { contactId: record.contactId, reused: record.contactReused };
  const ids = new Set(await bitrix.findContactIdsByPhone([identity.phone], opts));
  if (record.status === 'creating_contact') {
    for (const id of await bitrix.findByOrigin('contact', origin, opts)) ids.add(id);
  }
  if (ids.size > 1) return { blocked: `${ids.size} contacts in Bitrix have the phone ${identity.phone}` };
  if (ids.size === 1) {
    const contact = await bitrix.getContact([...ids][0], opts);
    if (!contact) return { blocked: 'the contact holding this phone could not be read' };
    if (contact.originId === origin) return { contactId: contact.id, reused: false };
    const parts = nameParts(identity.name);
    if (!contactMatches(contact, parts)) {
      return { blocked: `the phone ${identity.phone} belongs to another contact in Bitrix (${contact.name || `#${contact.id}`})` };
    }
    return { contactId: contact.id, reused: true };
  }
  if ((await findContactsByName(identity.name, opts)).length) {
    return { blocked: `a contact named ${identity.name} is already in Bitrix under another phone` };
  }
  await records.advance(record.id, ['claimed', 'creating_contact'], 'creating_contact');
  const contactId = await bitrix.createContact({
    ...fields, first: identity.first, last: identity.last, phone: identity.phone,
  }, { ...opts, audit: createAudit(record, 'contact', identity.displayName || identity.name) });
  return { contactId, reused: false };
}

/** The contact's open deal — this bot's own from an unanswered call, or one a person made. */
async function openDealOf(record, contactId, origin, opts) {
  const deals = await bitrix.listOpenDealsForContact(contactId, opts);
  if (record.status === 'creating_deal') {
    for (const id of await bitrix.findByOrigin('deal', origin, opts)) {
      if (deals.some((d) => d.id === id)) continue;
      const deal = await bitrix.getDeal(id, opts);
      if (deal && !deal.closed) deals.push(deal);
    }
  }
  return deals.sort(newestFirst)[0] || null;
}

/**
 * @param {object} args
 * @param {string} args.chatId
 * @param {number} args.rootMessageId  the conversation's post
 * @param {object} args.identity       lib/hiringStages/identity.js, `ok: true`
 * @param {string} args.categoryId     the pipeline a new deal goes in
 * @param {object[]} args.stages       that pipeline's stages (normalised)
 * @returns {Promise<{status: 'created', deal: object, contactReused: boolean}
 *   | {status: 'found', deal: object} | {status: 'blocked', reason: string}
 *   | {status: 'busy'} | {status: 'closed', dealId: number}>}
 * @throws {BitrixError} Bitrix could not be asked or refused — retryable ones leave the record to resume
 */
async function ensureCandidateDeal({
  chatId, rootMessageId, identity, categoryId, stages,
}, opts = {}) {
  const stage = startStage(stages);
  if (!stage) return { status: 'blocked', reason: `the pipeline has no "${START_STAGE_NAME}" stage to start a deal in` };

  const claimed = await records.claim({
    chatId, rootMessageId, phone: identity.phone, driverName: identity.name, displayName: identity.displayName || identity.name,
  });
  if (claimed.busy) return { status: 'busy' };
  const { record } = claimed;
  // Write the name the claim holds — the one this creation started with.
  const written = writtenName(record, identity);
  if (record.status === 'created') {
    const deal = record.dealId ? await bitrix.getDeal(record.dealId, opts) : null;
    return deal && !deal.closed ? { status: 'found', deal } : { status: 'closed', dealId: record.dealId };
  }

  const origin = originOf(chatId, rootMessageId);
  const cfg = await getBitrixConfig();
  const link = postLink(chatId, rootMessageId);
  const fields = {
    originId: origin,
    assignedById: Number(cfg.assignedById) > 0 ? Number(cfg.assignedById) : null,
    comments: `Created by the Wenze bot from the recruiting group${link ? `: ${link}` : ''}.`,
  };
  try {
    const contact = await resolveContact(record, { ...identity, ...written }, { origin, fields }, opts);
    if (contact.blocked) return block(record, contact.blocked);
    const atDeal = await records.advance(record.id, IN_FLIGHT, 'creating_deal', {
      contactId: contact.contactId, contactReused: contact.reused,
    });
    if (!atDeal) throw new Error('the creation record changed underneath');

    const existing = await openDealOf(record, contact.contactId, origin, opts);
    if (existing) {
      const ours = (await bitrix.findByOrigin('deal', origin, opts)).includes(existing.id);
      await records.advance(record.id, 'creating_deal', 'created', {
        dealId: existing.id, dealReused: !ours, categoryId: existing.categoryId, stageId: existing.stageId,
      });
      return ours ? { status: 'created', deal: existing, contactReused: contact.reused } : { status: 'found', deal: existing };
    }
    const dealId = await bitrix.createDeal({
      ...fields, title: written.displayName, categoryId, stageId: stage.id, contactId: contact.contactId,
    }, { ...opts, audit: createAudit(record, 'deal', written.displayName, { stage, categoryId, contactId: contact.contactId }) });
    await records.advance(record.id, 'creating_deal', 'created', {
      dealId, dealReused: false, categoryId: String(categoryId), stageId: stage.id,
    });
    const deal = await bitrix.getDeal(dealId, opts).catch(() => null) || {
      id: dealId, title: written.displayName, stageId: stage.id, categoryId: String(categoryId), contactId: contact.contactId,
    };
    return { status: 'created', deal, contactReused: contact.reused };
  } catch (err) {
    // An answer Bitrix will give again (no access, a refused field) ends here;
    // a call that may have reached Bitrix stays in flight, to be searched for.
    if (err instanceof bitrix.BitrixError && !err.retryable) {
      await records.advance(record.id, IN_FLIGHT, 'failed', { error: String(err.message).slice(0, 300) });
    }
    throw err;
  }
}

/**
 * A creation this conversation left IN FLIGHT — a call that got no answer — is
 * finished before anything else is read, from what was claimed (the name and
 * phone it started with): searched for first, added only if still missing.
 * @param {{chatId, rootMessageId, categoryId, loadStages: Function}} args
 * @returns {Promise<object|null>} ensureCandidateDeal's answer with the claimed name, phone and
 *   the stages read, or null when nothing is in flight
 */
async function resumeInFlight({
  chatId, rootMessageId, categoryId, loadStages,
}, opts = {}) {
  const record = await records.getForRoot(chatId, rootMessageId);
  if (!record || !IN_FLIGHT.includes(record.status)) return null;
  const displayName = record.displayName || record.driverName;
  const split = splitName(displayName);
  if (!split) return null;
  const identity = {
    ok: true, name: record.driverName, displayName, phone: record.phone, ...split,
  };
  const stages = await loadStages();
  const made = await ensureCandidateDeal({
    chatId, rootMessageId, identity, categoryId, stages,
  }, opts);
  return {
    ...made, driverName: identity.name, phone: identity.phone, stages,
  };
}

module.exports = {
  ensureCandidateDeal, resumeInFlight, startStage, originOf, START_STAGE_NAME,
};
