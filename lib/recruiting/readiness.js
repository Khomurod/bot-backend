'use strict';

const { effectiveReachability } = require('./reachability');

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
 * CONFIGURED IS NOT REACHABLE, and that gap was this feature's quietest
 * failure. `hoursConfigured` is a BOOLEAN — "somebody saved a window" — and a
 * reply needs two things true at once: the office closed AND not quiet hours.
 * So a schedule whose working windows and quiet period together cover the whole
 * week passed every check here and reported READY, with no moment in which any
 * candidate could ever be answered. `lib/recruiting/reachability.js` now sweeps
 * the week and answers the question that matters.
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
 * @param {object}  [state.schedule]             { timezone, windows, quietStartLocal, quietEndLocal }
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

  // THE ONE THAT ASKS WHETHER ANY CANDIDATE COULD EVER BE ANSWERED. Every check
  // above is a switch or a row count; this is the only one that looks at what
  // the settings MEAN together. Skipped when no schedule was supplied, so a
  // caller that has not wired it loses this answer rather than gaining a false
  // blocker — and `working_hours` above still catches the unconfigured case.
  const reach = state.schedule ? effectiveReachability(state.schedule) : null;
  if (reach && !reach.reachable) {
    blockers.push({
      key: 'no_reachable_window',
      what: `${reach.summary} Working hours and quiet hours have to leave a gap `
        + 'between them for Wenze to answer in.',
      where: 'Settings → Recruiting → Working hours',
    });
  }

  const ready = blockers.length === 0;
  return {
    ready,
    blockers,
    // The whole reachability answer, so a screen can show the gap and the
    // per-day detail without recomputing it.
    reachability: reach,
    // A DAY NOBODY CAN BE ANSWERED ON IS NOT A BLOCKER, because the feature does
    // work on the other days — but a candidate texting at 22:00 on a Tuesday is
    // never answered, ever, and that is worth saying out loud. Reported beside
    // `ready` rather than folded into it.
    unreachableDays: reach && reach.reachable ? reach.zeroDays : [],
    summary: ready
      ? 'Wenze can answer candidates outside working hours.'
      // Counted, because "not configured" reads like an optional extra and this
      // one costs a candidate.
      : `${blockers.length} thing${blockers.length === 1 ? '' : 's'} must be set before `
        + 'Wenze can answer a candidate outside working hours.',
  };
}

module.exports = { afterHoursReadiness };
