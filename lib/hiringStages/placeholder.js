'use strict';

/**
 * When may the bot OFFER to rename a candidate's Bitrix deal? Pure.
 *
 * Deals titled "No name" (in production exactly "No name" and two spaces) were
 * found by phone and moved, but never renamed (owner, 13–14 November 2026).
 * The card now offers "✏️ Name in Bitrix: “No name” → “Leah Ann Goodwin”?",
 * and only a press writes (services/hiringStages/rename.js).
 *
 *   - Only a PLACEHOLDER title: empty, "No name" in any spacing or case, or
 *     digits only. A real title — even one spelled differently — is a
 *     person's choice and is never offered.
 *   - Only in a HIRING pipeline. Never pipeline 3 "DRIVER RELATION", whose
 *     titles the Board ↔ Bitrix check owns (lib/boardBitrix/vocabulary.js),
 *     and never pipeline 33 "HOMETIME MONITORING", which holds copies of the
 *     drivers for home time (lib/homeTime/violations.js).
 *   - A contact's name is renamed with the deal only when it is a
 *     placeholder too (both parts empty, or "No name") — a real name on a
 *     contact is never overwritten.
 */

const { DEAL_CATEGORY_ID: BOARD_DRIVER_PIPELINE } = require('../boardBitrix/vocabulary');
const { CATEGORY_ID: HOME_TIME_PIPELINE } = require('../homeTime/violations');

const NOT_HIRING = new Set([String(BOARD_DRIVER_PIPELINE), String(HOME_TIME_PIPELINE)]);

function isPlaceholderTitle(title) {
  const text = String(title ?? '').trim();
  return text === '' || /^no\s*name$/i.test(text) || /^\d+$/.test(text);
}

function isHiringPipeline(categoryId) {
  return !NOT_HIRING.has(String(categoryId ?? '0').trim() || '0');
}

/** @param {{first?: string, last?: string, name?: string}} contact as services/bitrix24DealStages.js reads it */
function isPlaceholderContact(contact) {
  if (!contact) return false;
  const whole = String(contact.name ?? [contact.first, contact.last].filter(Boolean).join(' ')).replace(/\s+/g, ' ').trim();
  return whole === '' || /^no\s*name$/i.test(whole);
}

/** May the card offer to rename this deal to `displayName`? */
function mayOfferRename(deal, displayName) {
  return Boolean(deal && deal.id && displayName && String(displayName).trim())
    && !deal.closed && isPlaceholderTitle(deal.title) && isHiringPipeline(deal.categoryId);
}

module.exports = {
  isPlaceholderTitle, isHiringPipeline, isPlaceholderContact, mayOfferRename,
};
