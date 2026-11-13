'use strict';

/**
 * Renaming a candidate's PLACEHOLDER Bitrix deal ("No name"), BY BUTTON ONLY
 * (owner, 13–14 November 2026: deals titled "No name" were found by phone and
 * moved, but never renamed).
 *
 *   offer   the reviewer found the deal, its title is a placeholder and it is
 *           in a hiring pipeline (lib/hiringStages/placeholder.js): the
 *           driver's card gets "✏️ Name in Bitrix: “No name” → “<name>”?"
 *           with [✏️ Rename] [Keep as is]. The name is the post's words in
 *           Safety's spelling (lib/hiringStages/displayName.js). Offered once
 *           per conversation and deal. Nothing is written.
 *   press   anyone the Move button allows. The press CLAIMS the offer once,
 *           then the deal is READ AGAIN: its TITLE is written only while it is
 *           still exactly the placeholder shown ("renamed meanwhile — left as
 *           is" otherwise). Then the deal's contact is read, and its NAME /
 *           LAST_NAME written only when its own name is a placeholder too — a
 *           real name is never overwritten. One write per field.
 *   keep    recorded, the buttons go.
 *
 * Bitrix failing gives the claim back (`pending`), as a Move does; a title
 * already written by an earlier press that failed at the contact is not
 * written again.
 */

const renames = require('../../database/hiringStages/renames');
const bitrix = require('../bitrix24DealStages');
const { mayOfferRename, isPlaceholderContact } = require('../../lib/hiringStages/placeholder');
const { splitName } = require('../../lib/hiringStages/identity');
const msg = require('../../lib/hiringStages/messages');
const card = require('./card');

const convOf = (r, driverName = null) => ({ chatId: r.chatId, rootMessageId: r.rootMessageId, driverName });
const answer = (text, alert = false) => ({ text, alert });

/**
 * Offer the rename on the driver's card, when the deal's title is a placeholder.
 * Never throws: an offer that could not be shown is tried again on a later read.
 * @returns {Promise<'offered'|'not_offered'|'failed'>}
 */
async function offerRename(thread, deps, { deal, displayName, driverName }) {
  if (!mayOfferRename(deal, displayName)) return 'not_offered';
  let reserved = null;
  try {
    reserved = await renames.reserveRename({
      chatId: thread.chatId,
      rootMessageId: thread.rootMessageId,
      dealId: deal.id,
      categoryId: deal.categoryId,
      fromTitle: deal.title ?? '',
      toName: displayName,
      contactId: deal.contactId,
    });
    if (!reserved) return 'not_offered';
    const messageId = await card.offerAside(deps.telegram, deps.settings?.bitrixTopicId, convOf(reserved, driverName), {
      text: msg.renameText(reserved), keyboard: msg.renameKeyboard(reserved.id),
    });
    await renames.recordSent(reserved.id, messageId);
    return 'offered';
  } catch (err) {
    console.warn(`[HIRING STAGES] could not offer a rename: ${String(err?.message || err).slice(0, 120)}`);
    if (reserved) await renames.transition(reserved.id, 'pending', 'unsent', { error: String(err?.message || err).slice(0, 300) }).catch(() => {});
    return 'failed';
  }
}

async function close(telegram, row, outcome, extra = {}) {
  await card.closeAside(telegram, convOf(row), `${msg.CALLBACK_PREFIX}:rn:${row.id}`, msg.renameOutcomeLine(row, outcome, extra));
}

async function bitrixFailed(row, err) {
  await renames.transition(row.id, 'applying', 'pending', { error: String(err.message).slice(0, 300) });
  return answer(`Bitrix did not answer — nothing changed. Try again in a minute.\n${String(err.message).slice(0, 150)}`, true);
}

/** The deal's contact, renamed only when its own name is a placeholder. @returns whether it was */
async function renameContactIfPlaceholder(contactId, toName, opts) {
  if (!contactId) return false;
  const contact = await bitrix.getContact(contactId, opts);
  if (!isPlaceholderContact(contact)) return false;
  const split = splitName(toName);
  if (!split) return false;
  await bitrix.renameContact(contact.id, split, opts);
  return true;
}

async function confirmRename(row, by, deps) {
  let contactRenamed;
  let deal;
  try {
    deal = await bitrix.getDeal(row.dealId, deps.opts);
    if (deal && deal.title !== row.toName && deal.title !== row.fromTitle) {
      const stale = await renames.transition(row.id, 'applying', 'stale', { ...by, error: 'renamed meanwhile' });
      await close(deps.telegram, stale || row, 'stale');
      return answer('Renamed meanwhile — left as is.', true);
    }
    if (!deal) {
      const gone = await renames.transition(row.id, 'applying', 'stale', { ...by, error: 'deal not found' });
      await close(deps.telegram, gone || row, 'gone');
      return answer('That deal no longer exists in Bitrix.', true);
    }
    // Still the placeholder shown: the one TITLE write. Already the new name
    // (an earlier press failed at the contact): not written again.
    if (deal.title === row.fromTitle) await bitrix.renameDeal(row.dealId, row.toName, deps.opts);
    contactRenamed = await renameContactIfPlaceholder(deal.contactId, row.toName, deps.opts);
  } catch (err) {
    return bitrixFailed(row, err);
  }
  const applied = await renames.transition(row.id, 'applying', 'applied', { ...by, contactRenamed, contactId: deal.contactId });
  await close(deps.telegram, applied || { ...row, contactRenamed }, 'applied', { byName: by.userName });
  console.log(`[HIRING STAGES] rename ${row.id}: deal ${row.dealId} renamed by a group member`);
  return answer(`Done — renamed to ${row.toName}.`);
}

/**
 * A press on ✏️ Rename (`rn`) or Keep as is (`rk`), already checked to be a
 * person in the configured group (services/hiringStages/actions.js).
 * @returns {Promise<{text: string, alert: boolean}>}
 */
async function handleRenamePress({ action, id, chatId }, by, deps) {
  const current = await renames.getRename(id);
  if (!current || current.chatId !== String(chatId)) return answer('This offer no longer exists.', true);
  const claimed = await renames.transition(current.id, 'pending', 'applying', by);
  if (!claimed) return answer('Already answered.');
  if (action === 'rk') {
    const kept = await renames.transition(claimed.id, 'applying', 'declined', by);
    await close(deps.telegram, kept || claimed, 'declined', { byName: by.userName });
    return answer('OK — the name is left as it is.');
  }
  return confirmRename(claimed, by, deps);
}

module.exports = { offerRename, handleRenamePress };
