'use strict';

/**
 * WHOSE NUMBER a Facebook lead gets texted from.
 *
 * The rule the recruiting team asked for: whoever Bitrix24 assigned the lead to
 * is the person the driver hears from. Not a shared company number that then
 * has to be relayed by hand — the assigned recruiter's own number, so the
 * driver's reply lands in that recruiter's phone and the conversation is theirs.
 *
 * The sequence, per lead:
 *   1. Nobody mapped yet?        → shared number, no Bitrix call, no delay.
 *   2. Ask Bitrix who owns it    → bounded poll, because a distribution rule
 *      (crm.lead.get)              assigns the lead moments AFTER it is created.
 *   3. Map ASSIGNED_BY_ID → a    → send with that recruiter's own credential.
 *      recruiter that can send
 *   4. Anything missing or       → shared number, with a note the operator can
 *      broken along the way         act on. A lead is NEVER left un-texted.
 *
 * Step 4 is the part that must not be quiet. Falling back is correct behaviour
 * (a text from the wrong number beats no text at all), but an expired
 * RingCentral login looks exactly like success from the outside, so every
 * fallback that an operator could fix reports itself into the Telegram thread.
 */
const rc = require('../database/ringcentral');
const { waitForCrmAssignee } = require('./bitrix24Service');
const { sendSms, sendSmsAsRecruiter } = require('./ringCentralSmsService');

/**
 * Fallback reasons an operator can DO something about, and therefore the ones
 * worth a line in the Telegram thread. The rest are ordinary states of a
 * deployment that has not finished (or does not want) per-recruiter sending.
 */
const ACTIONABLE_FALLBACKS = new Set([
  'unassigned',
  'unmapped_assignee',
  'recruiter_not_configured',
  'recruiter_number_unusable',
  'recruiter_auth_failed',
  'recruiter_send_failed',
  'recruiter_number_not_on_extension',
  'recruiter_number_not_sms_capable',
  'crm_lookup_failed',
  'sender_lookup_failed',
]);

/**
 * Reasons `sendSmsAsRecruiter` reports precisely enough to surface as-is.
 * Anything else — an HTTP status, an exception — becomes the generic
 * `recruiter_send_failed`, because a status code is not something an operator
 * can act on.
 */
const SENDER_REASONS_PASSED_THROUGH = new Set([
  'recruiter_not_configured',
  'recruiter_number_unusable',
  'recruiter_auth_failed',
  'recruiter_number_not_on_extension',
  'recruiter_number_not_sms_capable',
]);

const FALLBACK_NOTES = {
  unassigned: 'Bitrix had not assigned the lead yet — sent from the shared number.',
  unmapped_assignee: 'The Bitrix user who owns this lead is not mapped to a recruiter — sent from the shared number.',
  recruiter_not_configured: 'has no RingCentral credentials — sent from the shared number.',
  recruiter_number_unusable: 'has a stored phone number that is not a number a text can be sent from (any format works) — sent from the shared number.',
  recruiter_auth_failed: 'could not authenticate with RingCentral (re-connect their account) — sent from the shared number.',
  recruiter_send_failed: 'could not send from their number (RingCentral refused it) — sent from the shared number.',
  // The two states that used to hide inside recruiter_send_failed as an opaque
  // MSG-245. They need different fixes, so they say different things.
  recruiter_number_not_on_extension: 'has a number RingCentral does not list on their extension (check the number in Settings → RingCentral) — sent from the shared number.',
  recruiter_number_not_sms_capable: 'has a number that cannot send SMS (it needs A2P/10DLC registration in RingCentral) — sent from the shared number.',
  crm_lookup_failed: 'Could not read the Bitrix assignee — sent from the shared number.',
  sender_lookup_failed: 'Could not look up the assigned recruiter — sent from the shared number.',
};

/**
 * Which recruiter should send this lead's text.
 *
 * @param {object} params
 * @param {number|string|null} params.bitrixId  the record crm.lead.add returned
 * @param {string} [params.entity]              'lead' | 'deal'
 * @param {object} [params.waitOptions]         passed to waitForCrmAssignee (tests)
 * @returns {Promise<{recruiter:object|null, assignedById:number|null, reason:string}>}
 */
async function resolveLeadSmsRecruiter({ bitrixId, entity, waitOptions = {} }) {
  if (!bitrixId) {
    return { recruiter: null, assignedById: null, reason: 'no_crm_record' };
  }

  // NOTHING HERE MAY THROW PAST THIS POINT. By the time a sender is chosen the
  // lead is already in Telegram and in the CRM; a database hiccup or a Bitrix
  // outage must cost the pretty sender name, not the driver's text.
  try {
    // Nothing to resolve to: keep the old path exactly, and do not spend a
    // request or a second of a driver's time finding that out.
    if (!(await rc.hasMappedSmsSenders())) {
      return { recruiter: null, assignedById: null, reason: 'no_mapped_recruiters' };
    }

    let matched = null;
    const outcome = await waitForCrmAssignee({
      bitrixId,
      entity,
      isAcceptable: async (assignedById) => {
        if (assignedById == null) return false;
        const row = await rc.getRecruiterByBitrixUserId(assignedById);
        if (!row || row.active === false) return false;
        if (!rc.recruiterCanSendSms(row)) return false;
        matched = row;
        return true;
      },
      ...waitOptions,
    });

    if (matched) {
      return { recruiter: matched, assignedById: outcome.assignedById, reason: 'assigned' };
    }
    if (outcome.assignedById != null) {
      // Bitrix named an owner; they are simply not a recruiter who can send.
      return { recruiter: null, assignedById: outcome.assignedById, reason: 'unmapped_assignee' };
    }
    if (outcome.reason && outcome.reason !== 'not_acceptable') {
      return { recruiter: null, assignedById: null, reason: 'crm_lookup_failed', detail: outcome.error };
    }
    return { recruiter: null, assignedById: null, reason: 'unassigned' };
  } catch (err) {
    console.warn('[LeadSMS] Could not resolve the assigned recruiter:', err.message);
    return { recruiter: null, assignedById: null, reason: 'sender_lookup_failed', detail: err.message };
  }
}

/** A human line for the Telegram thread, or null when the fallback is routine. */
function describeSenderFallback({ reason, recruiterName = null }) {
  if (!reason || !ACTIONABLE_FALLBACKS.has(reason)) return null;
  const note = FALLBACK_NOTES[reason];
  if (!note) return null;
  return recruiterName ? `${recruiterName} ${note}` : note;
}

/**
 * Send the lead's auto-SMS from the right number, falling back to the shared
 * one rather than dropping it.
 *
 * @param {object} params
 * @param {string} params.phone
 * @param {string} params.message
 * @param {number|string|null} [params.bitrixId]
 * @param {string} [params.entity]
 * @param {object} [params.waitOptions]
 * @returns {Promise<{smsResult:object, via:'recruiter'|'shared', recruiter:object|null,
 *   recruiterId:number|null, assignedById:number|null, fromNumber:string|null,
 *   fallbackReason:string|null, fallbackNote:string|null}>}
 */
async function sendLeadSms({ phone, message, bitrixId = null, entity, waitOptions = {} }) {
  const resolved = await resolveLeadSmsRecruiter({ bitrixId, entity, waitOptions });
  let fallbackReason = resolved.recruiter ? null : resolved.reason;
  let fallbackName = null;

  if (resolved.recruiter) {
    const attempt = await sendSmsAsRecruiter(resolved.recruiter, phone, message)
      .catch((err) => ({ ok: false, reason: 'recruiter_auth_failed', detail: err.message }));
    if (attempt.ok) {
      return {
        smsResult: attempt,
        via: 'recruiter',
        recruiter: resolved.recruiter,
        recruiterId: resolved.recruiter.id,
        assignedById: resolved.assignedById,
        // What actually sent — already E.164, and RingCentral's own spelling
        // when the send had to be corrected. NEVER the stored column: that is
        // the human-typed value, and recording it as the sender is what made
        // `sms_from_number` disagree with reality.
        fromNumber: attempt.fromNumber || null,
        fallbackReason: null,
        fallbackNote: null,
      };
    }
    // Their number could not send. The lead still gets its text.
    fallbackName = resolved.recruiter.name || null;
    fallbackReason = SENDER_REASONS_PASSED_THROUGH.has(attempt.reason)
      ? attempt.reason
      : 'recruiter_send_failed';
    console.warn(
      `[LeadSMS] ${fallbackName || `recruiter ${resolved.recruiter.id}`} could not send `
      + `(${attempt.reason}${attempt.detail ? `: ${String(attempt.detail).slice(0, 200)}` : ''}) — using the shared number.`
    );
  }

  const smsResult = await sendSms(phone, message);
  return {
    smsResult,
    via: 'shared',
    recruiter: null,
    recruiterId: null,
    assignedById: resolved.assignedById,
    fromNumber: smsResult.ok ? (smsResult.fromNumber || null) : null,
    fallbackReason,
    fallbackNote: describeSenderFallback({ reason: fallbackReason, recruiterName: fallbackName }),
  };
}

module.exports = {
  resolveLeadSmsRecruiter,
  sendLeadSms,
  describeSenderFallback,
  ACTIONABLE_FALLBACKS,
};
