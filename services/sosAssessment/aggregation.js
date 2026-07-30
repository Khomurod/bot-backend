/**
 * SOS assessment — pure aggregation for the public /answers projector pages.
 *
 * PRIVACY: this module is the anonymity boundary. Its output is served to an
 * unauthenticated page, so it must never include names, tokens, IPs,
 * submission ids, or any per-person record — only combined counts. Department
 * and dispatch-team results are shown for ANY group size (including one or two
 * respondents, as explicitly requested for this internal team event); privacy
 * is protected by never emitting identity fields, not by hiding small groups.
 * Question distributions carry option text + counts only, never the
 * option→pattern mapping (that would publish the scoring key). Enforced by
 * tests/sosAggregation.test.js.
 */

const { PATTERNS, DEPARTMENTS } = require('./constants');
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
      positive: block.strengths[0].uz,
      risk: block.risks[0].uz,
      sosQuestion: block.sosQuestions[0].uz,
    };
  }
  return meta;
}

/**
 * Builds the full anonymous summary for /answers and /answers/test.
 *
 * @param {Object} input
 * @param {boolean} input.open questionnaire open flag (for the mode being summarized)
 * @param {Array<{department, dispatchTeamId, dispatchTeamName, primaryPattern}>} input.submissions
 * @param {Array<{submissionDepartment, pattern, count}>} input.answerPatternRows
 * @param {Array<{questionKey, optionKey, count}>} input.questionOptionRows
 */
function buildSummary({ open, submissions, answerPatternRows = [], questionOptionRows = [] }) {
  const total = submissions.length;

  const companyPrimary = emptyPatternCounts();
  const deptData = new Map();
  const teamData = new Map();

  for (const dept of DEPARTMENTS) {
    deptData.set(dept.key, { key: dept.key, labelUz: dept.label.uz, count: 0, primaryCounts: emptyPatternCounts() });
  }

  for (const sub of submissions) {
    if (PATTERNS.includes(sub.primaryPattern)) companyPrimary[sub.primaryPattern] += 1;
    const dept = deptData.get(sub.department);
    if (dept) {
      dept.count += 1;
      if (PATTERNS.includes(sub.primaryPattern)) dept.primaryCounts[sub.primaryPattern] += 1;
    }
    if (sub.department === 'dispatch' && sub.dispatchTeamName) {
      const key = String(sub.dispatchTeamId ?? sub.dispatchTeamName);
      if (!teamData.has(key)) {
        teamData.set(key, { teamName: sub.dispatchTeamName, count: 0, primaryCounts: emptyPatternCounts() });
      }
      const team = teamData.get(key);
      team.count += 1;
      if (PATTERNS.includes(sub.primaryPattern)) team.primaryCounts[sub.primaryPattern] += 1;
    }
  }

  const companyAnswers = emptyPatternCounts();
  const deptAnswers = new Map();
  for (const row of answerPatternRows) {
    if (!PATTERNS.includes(row.pattern)) continue;
    companyAnswers[row.pattern] += Number(row.count) || 0;
    if (!deptAnswers.has(row.submissionDepartment)) deptAnswers.set(row.submissionDepartment, emptyPatternCounts());
    deptAnswers.get(row.submissionDepartment)[row.pattern] += Number(row.count) || 0;
  }

  // Question distributions: option text (uz) + counts only.
  const questionCounts = new Map();
  for (const row of questionOptionRows) {
    if (!questionCounts.has(row.questionKey)) questionCounts.set(row.questionKey, new Map());
    questionCounts.get(row.questionKey).set(row.optionKey, Number(row.count) || 0);
  }

  const departmentsOut = [];
  for (const dept of DEPARTMENTS) {
    const data = deptData.get(dept.key);
    const out = {
      key: dept.key,
      labelUz: dept.label.uz,
      count: data.count,
      primaryCounts: data.primaryCounts,
      answerPatternCounts: deptAnswers.get(dept.key) || emptyPatternCounts(),
    };
    if (data.count > 0) {
      out.topPatterns = topPatterns(data.primaryCounts);
      const tips = content.presentationUz.departmentTips[dept.key];
      if (tips) { out.technique = tips.technique; out.sosQuestions = tips.sosQuestions; }
      out.questions = (content.getQuestions(dept.key) || []).map((q) => {
        const counts = questionCounts.get(q.key) || new Map();
        return {
          key: q.key,
          textUz: q.text.uz,
          options: q.options.map((o) => ({ key: o.key, textUz: o.text.uz, count: counts.get(o.key) || 0 })),
        };
      });
    }
    departmentsOut.push(out);
  }

  const teamsOut = Array.from(teamData.values())
    .sort((a, b) => a.teamName.localeCompare(b.teamName))
    .map((team) => ({
      teamName: team.teamName,
      count: team.count,
      primaryCounts: team.primaryCounts,
      topPatterns: topPatterns(team.primaryCounts),
    }));

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
      primaryCounts: companyPrimary,
      answerPatternCounts: companyAnswers,
      topPatterns: topPatterns(companyPrimary, 3),
    },
    departments: departmentsOut,
    dispatchTeams: teamsOut,
  };
}

module.exports = { buildSummary, topPatterns };
