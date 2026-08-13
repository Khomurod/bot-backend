/**
 * SOS assessment — pure aggregation for the public /answers projector pages.
 *
 * ONE COMPANY-WIDE PICTURE. The public summary answers a single question:
 * "how do we, as one company, tend to react?" It reports, per thinking pattern,
 * the share of RESPONDENTS whose PRIMARY tendency is that pattern, how many
 * people that is, and an authored example of how that thinking sounds.
 *
 * PRIVACY: this module is the anonymity boundary. Its output is served to an
 * unauthenticated page, so it must never include names, tokens, IPs, submission
 * ids, or any per-person record — only combined counts. It also carries NO
 * department or dispatch-team results: no per-group counts, no per-group pattern
 * breakdowns, no question distributions, no ranking between groups. Those were
 * removed deliberately (a small group's numbers are close to a personal result,
 * and public group rankings turn a self-reflection exercise into a comparison);
 * the data still exists in the database and is reachable through the ADMIN API
 * only. Question distributions are gone too, so the option→pattern mapping (the
 * scoring key) cannot be reconstructed from the public payload. The example
 * quotes come from content/results/*.js — authored text, never a submitted
 * answer. Enforced by tests/sosAggregation.test.js.
 */

const { PATTERNS } = require('./constants');
const content = require('./content');

function emptyPatternCounts() {
  const counts = {};
  for (const pattern of PATTERNS) counts[pattern] = 0;
  return counts;
}

/** Top patterns (desc by count, only counts > 0), for "most common" displays. */
function topPatterns(counts, limit = 2) {
  return PATTERNS
    .filter((p) => counts[p] > 0)
    .sort((a, b) => counts[b] - counts[a] || PATTERNS.indexOf(a) - PATTERNS.indexOf(b))
    .slice(0, limit);
}

/** Uzbek display metadata per pattern for the projector page. */
function patternMetaUz() {
  const meta = {};
  for (const pattern of PATTERNS) {
    const block = content.getPatternResult(pattern);
    meta[pattern] = {
      name: block.name.uz,
      // An authored illustration of the pattern — NOT anyone's submitted answer.
      example: block.exampleThought.uz,
      positive: block.strengths[0].uz,
      risk: block.risks[0].uz,
      sosQuestion: block.sosQuestions[0].uz,
    };
  }
  return meta;
}

/**
 * Whole-number percentages of RESPONDENTS per pattern, in canonical order.
 *
 * The denominator is the number of RESPONDENTS — never the number of individual
 * answers — so "18%" always means "18% of the people who filled the form".
 *
 * Each row is rounded on its own (`count / total × 100`, nearest whole number),
 * because on a projector every row has to survive being checked by hand: 9 of 33
 * people reads as 27%, and no redistribution may push it to 28% to make the
 * column add up. Rounding therefore leaves the displayed percentages summing to
 * 100 ± a couple of points; the head counts are the exact figures and they always
 * add up to the total. A pattern with zero respondents is always exactly 0%.
 */
function primaryPatternShares(counts, total) {
  return PATTERNS.map((pattern) => {
    const count = counts[pattern] || 0;
    return {
      pattern,
      count,
      percent: total > 0 ? Math.round((count * 100) / total) : 0,
    };
  });
}

/**
 * Builds the full anonymous, company-wide summary for /answers and /answers/test.
 *
 * @param {Object} input
 * @param {boolean} input.open questionnaire open flag (for the mode being summarized)
 * @param {Array<{primaryPattern: string}>} input.submissions one entry per respondent
 */
function buildSummary({ open, submissions = [] }) {
  const total = submissions.length;

  const primaryCounts = emptyPatternCounts();
  for (const sub of submissions) {
    if (PATTERNS.includes(sub.primaryPattern)) primaryCounts[sub.primaryPattern] += 1;
  }

  return {
    open,
    total,
    patternMeta: patternMetaUz(),
    presentation: {
      title: content.presentationUz.title,
      subtitle: content.presentationUz.subtitle,
      centralQuestion: content.presentationUz.centralQuestion,
      centralQuestionIntro: content.presentationUz.centralQuestionIntro,
      techniques: content.presentationUz.techniques,
      practices: content.presentationUz.practices,
    },
    company: {
      // One row per pattern, canonical order, percentages of respondents.
      primaryPatterns: primaryPatternShares(primaryCounts, total),
      topPatterns: topPatterns(primaryCounts, 3),
    },
  };
}

module.exports = { buildSummary, topPatterns, primaryPatternShares };
