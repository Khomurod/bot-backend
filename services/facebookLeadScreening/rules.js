'use strict';

/**
 * Which Facebook lead's OWN form answers rule them out — pure, no I/O.
 *
 * The owner, 23 November 2026: the strict form (1314514344109886) closed itself
 * on any wrong answer and verified the phone by SMS, and 1000 impressions cost
 * $416 against $36 for the old form in the same ad set. The filter moved out of
 * the form: the "light screen" form (1296243945998781) asks the same questions
 * but takes every answer, and a lead who answered No to one of them goes
 * straight to Lost in Bitrix with the reason, never to a recruiter's queue
 * (services/facebookLeadScreening/close.js).
 *
 * A QUESTION IS RECOGNISED BY ITS WORDS, NOT BY ITS FORM. Meta names a custom
 * question's field after its text ("do_you_have_a_valid_class_a_cdl?"), so the
 * key is squeezed to letters and digits and matched on phrases only these
 * questions use. A question that matches none of them is never a reason; an
 * answer other than a plain "No" never is either. Ambiguous older questions
 * ("Are you CDL-A over the road driver?" — No could mean either half) are
 * deliberately not matched.
 *
 * The order below is the order a reason is CHOSEN in when several apply: Bitrix
 * holds one lost reason, and no Class A CDL says the most.
 */

const RULES = Object.freeze([
  {
    reason: 'no_cdl_a',
    question: 'a valid Class A CDL',
    matches: (key) => key.includes('validclassacdl'),
  },
  {
    reason: 'experience',
    question: '2+ years of verifiable OTR experience',
    matches: (key) => /(?:^|[^0-9])(?:2|two)years/.test(key) && /otr|overtheroad/.test(key),
  },
  {
    reason: 'record',
    question: 'a driving record that meets the requirements',
    matches: (key) => key.includes('drivingrecord') && key.includes('meet'),
  },
  {
    reason: 'contract_1099',
    question: 'a 1099 OTR position, out 2+ weeks at a time',
    matches: (key) => key.includes('1099'),
  },
]);

/** "Do you have a valid Class A CDL?" / "do_you_have_a_valid_class_a_cdl?" → "doyouhaveavalidclassacdl". */
function squeeze(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function ruleForKey(key) {
  const squeezed = squeeze(key);
  return squeezed ? RULES.find((rule) => rule.matches(squeezed)) || null : null;
}

/**
 * @param {Record<string, string>} fieldMap  the lead's answers, Meta field name → value
 * @returns {{screenedOut: boolean, failed: Array<{reason: string, question: string}>}}
 *   `failed` in RULES order, each reason once
 */
function screenLeadAnswers(fieldMap) {
  const failedReasons = new Set();
  for (const [key, value] of Object.entries(fieldMap || {})) {
    const rule = ruleForKey(key);
    if (rule && squeeze(value) === 'no') failedReasons.add(rule.reason);
  }
  const failed = RULES
    .filter((rule) => failedReasons.has(rule.reason))
    .map(({ reason, question }) => ({ reason, question }));
  return { screenedOut: failed.length > 0, failed };
}

/** The one reason Bitrix is given: the first failure in RULES order, or null. */
function primaryReason(screening) {
  return screening?.failed?.[0]?.reason || null;
}

/** "a valid Class A CDL; 2+ years of verifiable OTR experience" */
function failedQuestions(screening) {
  return (screening?.failed || []).map((f) => f.question).join('; ');
}

/** The note left on the Bitrix deal. Question labels only — no name, no phone. */
function dealComment(screening, formId) {
  const form = formId ? ` (Facebook form ${formId})` : '';
  return `Closed automatically as Lost: on the Facebook form${form} the candidate answered No to: `
    + `${failedQuestions(screening)}. If this is a mistake, move the deal back to New Lead.`;
}

/**
 * The line posted to the leads group under the lead. `outcome` is what
 * close.js answered: closed, already closed, or why it could not close.
 */
function screenedOutNotice({ leadName, screening, outcome }) {
  const who = leadName || 'This lead';
  const lines = [`🚫 ${who} is not a fit by the form answers: answered No to ${failedQuestions(screening)}.`];
  if (outcome?.closed) {
    lines.push(`Closed as Lost in Bitrix (deal ${outcome.dealId}).`);
  } else if (outcome?.already) {
    lines.push(`The Bitrix deal ${outcome.dealId} was already closed as Lost.`);
  } else {
    lines.push(`Not closed in Bitrix automatically (${outcome?.why || 'no Bitrix record'}). A recruiter can close it, or call if the answer was a mistake.`);
  }
  lines.push('No auto-SMS was sent.');
  return lines.join('\n');
}

module.exports = {
  RULES,
  squeeze,
  screenLeadAnswers,
  primaryReason,
  failedQuestions,
  dealComment,
  screenedOutNotice,
};
