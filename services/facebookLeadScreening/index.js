'use strict';

/**
 * A Facebook lead whose own form answers rule them out, as one step of the
 * lead chain (services/facebookLeadEventProcessor.js): close their Bitrix deal
 * as Lost with the reason, tell the leads group, and send NO auto-SMS — the
 * text promises a recruiter's call that is not coming (the owner, 23 November
 * 2026: "кто не подходит, сразу уходит в Lost с причиной, рекрутеры ему не
 * звонят").
 *
 *   ./rules.js   which answers rule a lead out, and the words (pure)
 *   ./close.js   the Bitrix deal, found, checked and closed (I/O)
 */

const { screenLeadAnswers, screenedOutNotice } = require('./rules');
const { closeScreenedOutLead, isEnabled } = require('./close');

/** The screening of these answers, or "not screened out" while switched off. */
function screenLead(fieldMap) {
  if (!isEnabled()) return { screenedOut: false, failed: [] };
  return screenLeadAnswers(fieldMap);
}

/**
 * Close and announce. Never throws: a Bitrix or Telegram failure here costs the
 * lead nothing it already has (its post, its `leads` row).
 *
 * @param {object} args
 * @param {(text: string) => Promise<*>} args.announce  posts one line to the lead's group
 */
async function handleScreenedOutLead({
  screening, bitrixResult, leadgenId, formId, leadName, announce, close = closeScreenedOutLead,
}) {
  let outcome;
  try {
    outcome = await close({
      bitrixResult, screening, leadgenId, formId, leadName,
    });
  } catch (err) {
    outcome = { closed: false, why: `an error: ${String(err?.message || err).slice(0, 120)}` };
  }
  try {
    await announce(screenedOutNotice({ leadName, screening, outcome }));
  } catch (err) {
    console.error('[Leads] Could not post the screened-out notice:', String(err?.message || err).slice(0, 200));
  }
  console.log(`[Leads] Lead ${leadgenId} screened out by its form answers `
    + `(${screening.failed.map((f) => f.reason).join(', ')}) — ${outcome.closed ? `deal ${outcome.dealId} closed as Lost` : (outcome.already ? 'already Lost' : `not closed: ${outcome.why}`)}; no auto-SMS.`);
  return outcome;
}

module.exports = { screenLead, handleScreenedOutLead };
