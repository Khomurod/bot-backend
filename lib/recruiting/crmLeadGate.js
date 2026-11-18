'use strict';

/**
 * May a Facebook lead become a Bitrix record? Pure.
 *
 * THE OWNER'S RULE (18 November 2026): "only leads with a name and a phone
 * number go to Bitrix". A record with no name or no number is a person nobody
 * can call, and Bitrix filling up with such people (Facebook commenters, the
 * owner reported) is what prompted the rule. Wenze itself only ever files
 * lead-FORM submissions, never comments or Messenger messages
 * (services/facebookWebhookService.js takes `leadgen` changes and Messenger
 * events, and Messenger only reaches Telegram), and this gate makes sure even
 * a form lead reaches Bitrix only with both:
 *
 *   name   at least two letters in the first and last name together (a form
 *          whose name question was left empty, or answered "." or "1", is no
 *          name);
 *   phone  a number that can actually be called or texted — the same test the
 *          SMS sender uses (lib/phone/e164.js `toE164`): ten digits, or eleven
 *          starting with 1, or a full international number with its "+".
 *
 * The recruiting team still sees EVERY lead in the leads Telegram group; only
 * the Bitrix record is held back.
 */

const { toE164 } = require('../phone/e164');

const MIN_NAME_LETTERS = 2;

const letterCount = (text) => (String(text || '').match(/\p{L}/gu) || []).length;

/**
 * @param {{firstName?: string, lastName?: string, phone?: string}} lead
 * @returns {{ok: true} | {ok: false, missing: Array<'name'|'phone'>}}
 */
function crmLeadReadiness({ firstName = '', lastName = '', phone = '' } = {}) {
  const missing = [];
  if (letterCount(`${firstName} ${lastName}`) < MIN_NAME_LETTERS) missing.push('name');
  if (!toE164(phone)) missing.push('phone');
  return missing.length ? { ok: false, missing } : { ok: true };
}

module.exports = { crmLeadReadiness, MIN_NAME_LETTERS };
