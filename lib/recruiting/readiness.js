'use strict';

/**
 * Whether Wenze can answer a candidate after hours, and what is missing. PURE.
 *
 * WHY A DEDICATED ANSWER. The after-hours reply has five independent
 * preconditions and every one of them is somebody's decision rather than a
 * fault: working hours nobody has set, nothing approved for it to say, the AI
 * capability switched off, no AI provider enabled, no recruiter with a
 * RingCentral login. Miss any one and the feature is silently inert — a
 * candidate texts at 9pm on a Friday and hears nothing until Monday, which is
 * the exact situation it was built to prevent.
 *
 * `afterHoursReply` already names every exit it takes, which is the right
 * design for a log. It is the wrong shape for a screen: by the time it has a
 * reason there is a candidate waiting. This answers the question BEFORE
 * anybody texts, so the gap is visible on a quiet Tuesday afternoon.
 *
 * IT DOES NOT INVENT ANY OF THE ANSWERS. "Nothing has been approved" is a
 * count of rows a person confirmed; the fix is for a person to write one. What
 * a company offers a driver is never filled in from here — see
 * `docs/architecture/recruiting-knowledge.md`.
 */

/**
 * @param {object} state
 * @param {boolean} [state.hoursConfigured]      any working-hour window is set
 * @param {boolean} [state.afterHoursEnabled]    the feature's own switch
 * @param {number}  [state.approvedStatements]   confirmed `recruiting_knowledge` rows
 * @param {boolean} [state.capabilityEnabled]    the AI capability is permitted
 * @param {boolean} [state.aiProviderEnabled]    at least one provider is usable
 * @param {number}  [state.recruitersWithSms]    recruiters who can actually text
 * @returns {{ready: boolean, blockers: Array<{key,what,where}>, summary: string}}
 */
function afterHoursReadiness(state = {}) {
  const blockers = [];
  const need = (key, condition, what, where) => {
    if (!condition) blockers.push({ key, what, where });
  };

  need('after_hours_enabled', state.afterHoursEnabled === true,
    'After-hours replies are switched off.',
    'Settings → Recruiting → Working hours');

  need('working_hours', state.hoursConfigured === true,
    'No working hours are set, so Wenze cannot tell when the team has gone home.',
    'Settings → Recruiting → Working hours');

  need('approved_knowledge', Number(state.approvedStatements || 0) > 0,
    'Nothing has been approved for Wenze to say, so it has nothing it is allowed '
    + 'to tell a candidate.',
    'Settings → Recruiting → Teach Wenze');

  need('ai_capability', state.capabilityEnabled === true,
    'The after-hours reply capability is switched off.',
    'Settings → AI → Responsibilities');

  need('ai_provider', state.aiProviderEnabled === true,
    'No AI provider is enabled, so there is nothing to compose a reply.',
    'Settings → AI');

  need('recruiter_sms', Number(state.recruitersWithSms || 0) > 0,
    'No recruiter has a RingCentral login, so a reply could not be sent from '
    + 'their own number.',
    'Settings → RingCentral');

  const ready = blockers.length === 0;
  return {
    ready,
    blockers,
    summary: ready
      ? 'Wenze can answer candidates outside working hours.'
      // Counted, because "not configured" reads like an optional extra and this
      // one costs a candidate.
      : `${blockers.length} thing${blockers.length === 1 ? '' : 's'} must be set before `
        + 'Wenze can answer a candidate outside working hours.',
  };
}

module.exports = { afterHoursReadiness };
