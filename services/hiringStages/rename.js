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
 *           then the deal is READ AGAIN: gone, closed, or no longer in a
 *           hiring pipeline (moved into the Board's pipeline 3 since the
 *           offer) → nothing is written. Its TITLE is written only while it
 *           is still exactly the placeholder shown ("renamed meanwhile — left
 *           as is" otherwise, even when a person typed the same name). Then
 *           the deal's contact is read, and its NAME / LAST_NAME written only
 *           when its own name is a placeholder too — a real name is never
 *           overwritten. One write per field.
 *   keep    recorded, the buttons go.
 *
 * Bitrix failing gives the claim back (`pending`), as a Move does. A title
 * write is recorded the moment Bitrix confirms it (`title_written`): a press
 * that then failed at the contact says so, and the next press finishes the
 * contact without writing the title again.
 */

const renames = require('../../database/hiringStages/renames');
const bitrix = require('../bitrix24DealStages');
const { mayOfferRename, isPlaceholderContact, isHiringPipeline } = require('../../lib/hiringStages/placeholder');
const { splitName } = require('../../lib/hiringStages/identity');
const msg = require('../../lib/hiringStages/messages');
const card = require('./card');

const convOf = (r, driverName = null) => ({ chatId: r.chatId, rootMessageId: r.rootMessageId, driverName });
const answer = (text, alert = false) => ({ text, alert });
/** Bitrix reads an empty TITLE back as null: what is stored and what is read are compared as text. */
const titleOf = (title) => String(title ?? '');

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
      fromTitle: titleOf(deal.title),
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

/**
 * Bitrix failed: the claim goes back. A title an earlier step of THIS press
 * already wrote is said — it was renamed, only its contact was not.
 */
async function bitrixFailed(row, err, titleWritten = false) {
  await renames.transition(row.id, 'applying', 'pending', { error: String(err.message).slice(0, 300) });
  const why = String(err.message).slice(0, 150);
  if (titleWritten) {
    return answer(`The deal is renamed to ${row.toName}, but Bitrix did not answer for its contact. Press again in a minute.\n${why}`, true);
  }
  return answer(`Bitrix did not answer — nothing changed. Try again in a minute.\n${why}`, true);
}

/** The contact's name, renamed only when its own name is a placeholder. @returns whether it was */
async function renameContactIfPlaceholder(contactId, toName, opts, row, by) {
  if (!contactId) return false;
  const contact = await bitrix.getContact(contactId, opts);
  if (!isPlaceholderContact(contact)) return false;
  const split = splitName(toName);
  if (!split) return false;
  await bitrix.renameContact(contact.id, split, { ...opts, audit: renameAudit(row, by, 'contact', contact.name, split) });
  return true;
}

/**
 * Who pressed ✏️ Rename, and what it changed — for Monitoring → Logs. The
 * names are the change itself; both are taken out after 60 days.
 */
function renameAudit(row, by, what, fromName, split = null) {
  return {
    actorKind: 'person_button',
    actorTelegramId: by?.userId ?? null,
    actorName: by?.userName || null,
    trigger: 'hiring_stage.rename',
    reason: what === 'deal'
      ? 'Pressed ✏️ Rename on a deal with a placeholder title (read again first: still the placeholder).'
      : 'The same ✏️ Rename press: the deal\'s contact still had a placeholder name.',
    evidence: {
      renameId: row.id, chatId: row.chatId, rootMessageId: row.rootMessageId, dealId: row.dealId,
    },
    targetLabel: row.toName,
    change: what === 'deal'
      ? [{ field: 'TITLE', from: fromName, to: row.toName }]
      : [{ field: 'NAME', from: fromName, to: split ? `${split.first} ${split.last}` : row.toName }],
  };
}

/** Ends the press without writing: the row goes `stale` with `error`, the aside closes with `outcome`. */
async function leave(row, by, deps, { outcome, error, text }) {
  const stale = await renames.transition(row.id, 'applying', 'stale', { ...by, error });
  await close(deps.telegram, stale || row, outcome);
  return answer(text, true);
}

async function confirmRename(row, by, deps) {
  let contactRenamed;
  let deal;
  let titleWritten = row.titleWritten;
  try {
    deal = await bitrix.getDeal(row.dealId, deps.opts);
    if (!deal) return leave(row, by, deps, { outcome: 'gone', error: 'deal not found', text: 'That deal no longer exists in Bitrix.' });
    // What made the offer allowed is checked again: a deal moved into the
    // Board's pipeline 3 (or 33), or closed, since the offer is never written.
    if (deal.closed || !isHiringPipeline(deal.categoryId)) {
      return leave(row, by, deps, {
        outcome: 'left', error: 'deal closed or left the hiring pipeline', text: 'Not renamed: the deal is closed or no longer in a hiring pipeline.',
      });
    }
    const now = titleOf(deal.title);
    // The new name is ours only when THIS offer wrote it (an earlier press
    // that then failed at the contact) — a person typing the same name is
    // "renamed meanwhile", like any other change.
    const ours = titleWritten && now === row.toName;
    if (!ours && now !== titleOf(row.fromTitle)) {
      return leave(row, by, deps, { outcome: 'stale', error: 'renamed meanwhile', text: 'Renamed meanwhile — left as is.' });
    }
    if (!ours) {
      // Still exactly the placeholder shown: the one TITLE write, recorded at once.
      await bitrix.renameDeal(row.dealId, row.toName, { ...deps.opts, audit: renameAudit(row, by, 'deal', deal.title) });
      titleWritten = true;
      await renames.markTitleWritten(row.id);
    }
    contactRenamed = await renameContactIfPlaceholder(deal.contactId, row.toName, deps.opts, row, by);
  } catch (err) {
    return bitrixFailed(row, err, titleWritten);
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
