'use strict';

/**
 * Chats this deployment ALREADY sends operational traffic to. PURE.
 *
 * WHY THIS EXISTS, AND WHAT IT DELIBERATELY DOES NOT DO. Production currently
 * has no notification destination configured, so every operational notice is
 * discarded at the door. The obstacle is not that nobody wants one — it is that
 * setting it means finding a Telegram chat id, which nobody has to hand.
 *
 * So this reads the ids the application is ALREADY configured with and offers
 * them as candidates, with a sentence saying what each one currently receives.
 * It is a shortcut for a person, not a decision:
 *
 *   NOTHING HERE IS EVER APPLIED AUTOMATICALLY. An administrator picks one and
 *   the existing save path validates it like any typed id. Silently routing
 *   safety escalations and fuel risks into the chat that receives survey
 *   results would be rerouting an audience nobody asked to change, and the
 *   whole reason this feature exists is that a destination chosen without a
 *   person's attention goes wrong quietly.
 *
 *   IT NEVER INVENTS AN ID. Every candidate comes from configuration that is
 *   already set; an unset variable produces no candidate rather than a guess.
 *
 * The chat ids themselves are NOT secrets in this application — they are typed
 * into the admin by hand — but they are only ever returned to an authenticated
 * administrator, never to `/api/health`.
 */

/**
 * @param {object} config  the resolved `config/config.js`
 * @returns {Array<{chatId: string, label: string, what: string}>}
 */
function notificationCandidates(config = {}) {
  const seen = new Set();
  const out = [];
  const add = (chatId, label, what) => {
    const id = String(chatId ?? '').trim();
    // An unset variable is not a candidate. Offering a blank would be offering
    // "send these nowhere", dressed up as a choice.
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ chatId: id, label, what });
  };

  add(
    config.managementGroupId,
    'Management group',
    'Already receives survey results, questions, confirmations, broadcasts and AI reports.'
  );
  add(
    config.dispatchReviewGroupId,
    'Dispatch review',
    'Already receives dispatch review traffic.'
  );
  add(
    config.anonymousFeedbackGroupId,
    'Anonymous feedback',
    'Already receives anonymous driver feedback.'
  );
  add(
    config.employeeGroupId,
    'Employee group',
    'Already receives employee birthday greetings.'
  );

  return out;
}

module.exports = { notificationCandidates };
