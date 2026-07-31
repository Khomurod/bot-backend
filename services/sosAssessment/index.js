/**
 * SOS assessment — service façade (orchestration).
 *
 * Public flow: meta → questionnaire → submit (server-side deterministic
 * scoring, duplicate detection, atomic store) → personal result; plus the
 * anonymous aggregate summary for the /answers projector page. Admin helpers
 * resolve stored keys back to display text through the content modules.
 *
 * No AI anywhere in this flow — results are computed by scoring.js and
 * snapshotted at submit time.
 */

const crypto = require('crypto');
const db = require('../../database/sosAssessment');
const { publicDispatchTeams, findDispatchTeamByKey } = require('./dispatchTeams');
const content = require('./content');
const { scoreAnswers, normalizeName, SosValidationError } = require('./scoring');
const { buildSummary } = require('./aggregation');
const { LANGUAGES, DEPARTMENT_KEYS, PATTERNS } = require('./constants');

function serviceError(code, message, status, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  err.extra = extra;
  return err;
}

/** Personal result payload in one language (used by submit and token re-view). */
function buildResultPayload({ language, primaryPattern, secondaryPattern, patternScores, createdAt }) {
  const patternNames = {};
  for (const pattern of PATTERNS) {
    patternNames[pattern] = content.getPatternResult(pattern).name[language];
  }
  return {
    language,
    scores: patternScores,
    patternNames,
    primary: content.resultForLanguage(primaryPattern, language),
    secondary: secondaryPattern ? content.resultForLanguage(secondaryPattern, language) : null,
    common: content.resultCommonForLanguage(language),
    submittedAt: createdAt,
  };
}

/** The open switch for the requested mode (real vs test are independent). */
function openFlagFor(settings, isTest) {
  return isTest === true ? settings.testIsOpen : settings.isOpen;
}

async function getMeta(isTest) {
  const settings = await db.getSettings();
  return {
    open: openFlagFor(settings, isTest),
    isTest: isTest === true,
    contentVersion: content.CONTENT_VERSION,
    departments: content.DEPARTMENTS,
    // The authoritative in-code list — no database read, so the team choices
    // cannot vary between the real and test flows or drift with unrelated
    // operational records.
    dispatchTeams: publicDispatchTeams(),
  };
}

async function getQuestionnaire(departmentKey, isTest) {
  if (!DEPARTMENT_KEYS.includes(departmentKey)) {
    throw serviceError('UNKNOWN_DEPARTMENT', 'Unknown department', 400);
  }
  const settings = await db.getSettings();
  if (!openFlagFor(settings, isTest)) throw serviceError('SOS_CLOSED', 'The questionnaire is closed', 403, { closed: true });
  // Same content modules serve both modes — the test flow can never drift
  // from the approved 70 questions, translations, or scoring.
  return {
    contentVersion: content.CONTENT_VERSION,
    department: departmentKey,
    questions: content.toPublicQuestions(departmentKey),
  };
}

async function submitAssessment(input) {
  const isTest = input.isTest === true;
  const settings = await db.getSettings();
  if (!openFlagFor(settings, isTest)) throw serviceError('SOS_CLOSED', 'The questionnaire is closed', 403, { closed: true });

  const fullName = typeof input.fullName === 'string' ? input.fullName.trim() : '';
  if (fullName.length < 3 || fullName.length > 120) {
    throw serviceError('INVALID_NAME', 'Please enter your full name', 400);
  }
  if (!LANGUAGES.includes(input.language)) throw serviceError('INVALID_LANGUAGE', 'Unknown language', 400);
  if (!DEPARTMENT_KEYS.includes(input.department)) throw serviceError('UNKNOWN_DEPARTMENT', 'Unknown department', 400);
  if (Number(input.contentVersion) !== content.CONTENT_VERSION) {
    throw serviceError('STALE_CONTENT', 'The questionnaire was updated — please reload the page', 409, { staleContent: true });
  }

  // Dispatch REQUIRES one of the six authoritative teams. dispatch_team_id stays
  // NULL on purpose: it is a foreign key into the unrelated Raise Approval
  // dispatch_teams table, and the exact snapshotted name is the identity here.
  let dispatchTeamName = null;
  if (input.department === 'dispatch') {
    const hasKey = !(input.dispatchTeamKey === undefined || input.dispatchTeamKey === null || input.dispatchTeamKey === '');
    // A page loaded BEFORE this deployment still sends the old numeric
    // `dispatchTeamId`. Those ids belong to the unrelated Raise Approval
    // dispatch_teams rows, so translating one would file the person under the
    // WRONG team — worse than failing. The questions themselves did not change,
    // so CONTENT_VERSION cannot flag it either. Route it into the SAME
    // stale-content flow the page already has, which tells the employee to
    // reload and pick their team, instead of an unexplained "select your team"
    // error after they have answered everything.
    if (!hasKey && input.dispatchTeamId !== undefined && input.dispatchTeamId !== null && input.dispatchTeamId !== '') {
      throw serviceError('STALE_CONTENT', 'The questionnaire was updated — please reload the page', 409, { staleContent: true });
    }
    if (!hasKey) {
      throw serviceError('TEAM_REQUIRED', 'Please select your dispatch team', 400);
    }
    const team = findDispatchTeamByKey(input.dispatchTeamKey);
    if (!team) throw serviceError('UNKNOWN_TEAM', 'Unknown dispatch team', 400);
    dispatchTeamName = team.name;
  }

  // Deterministic server-side scoring from option keys (throws typed 400s).
  const scored = scoreAnswers(input.department, input.answers);

  // Duplicate detection is mode-scoped: a rehearsal on /questions/test never
  // blocks (or is blocked by) the same person's real submission.
  const nameNormalized = normalizeName(fullName);
  const duplicate = await db.findDuplicate(nameNormalized, input.department, isTest);
  if (duplicate && input.confirmDuplicate !== true) {
    throw serviceError('DUPLICATE', 'A submission with this name already exists', 409, {
      duplicate: true,
      submittedAt: duplicate.createdAt,
    });
  }

  const resultToken = crypto.randomBytes(16).toString('hex');
  const created = await db.createSubmission({
    fullName,
    nameNormalized,
    department: input.department,
    dispatchTeamId: null,
    dispatchTeamName,
    language: input.language,
    contentVersion: content.CONTENT_VERSION,
    patternScores: scored.scores,
    primaryPattern: scored.primary,
    secondaryPattern: scored.secondary,
    resultToken,
    duplicateConfirmed: duplicate ? true : false,
    clientIp: input.clientIp || null,
    isTest,
    answers: scored.answerSnapshots,
  });

  return {
    resultToken,
    result: buildResultPayload({
      language: input.language,
      primaryPattern: scored.primary,
      secondaryPattern: scored.secondary,
      patternScores: scored.scores,
      createdAt: created.createdAt,
    }),
  };
}

async function getResultByToken(token, isTest) {
  if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) {
    throw serviceError('NOT_FOUND', 'Result not found', 404);
  }
  // Mode-scoped lookup: a real token 404s on the test route and vice versa.
  const stored = await db.getSubmissionByToken(token, isTest);
  if (!stored) throw serviceError('NOT_FOUND', 'Result not found', 404);
  return buildResultPayload({
    language: stored.language,
    primaryPattern: stored.primaryPattern,
    secondaryPattern: stored.secondaryPattern,
    patternScores: stored.patternScores,
    createdAt: stored.createdAt,
  });
}

/** Anonymous aggregates for /answers (real) or /answers/test — one mode only. */
async function getPublicSummary(isTest) {
  const [settings, rows] = await Promise.all([db.getSettings(), db.getSummaryRows(isTest === true)]);
  return buildSummary({ open: openFlagFor(settings, isTest), ...rows });
}

// ─────────────────────────── Admin helpers ───────────────────────────

/** Both modes side by side, each computed from mode-scoped SQL. */
async function getAdminStatus() {
  const [settings, realStats, testStats] = await Promise.all([
    db.getSettings(),
    db.getCompletionStats(false),
    db.getCompletionStats(true),
  ]);
  return {
    open: settings.isOpen,
    testOpen: settings.testIsOpen,
    updatedAt: settings.updatedAt,
    contentVersion: content.CONTENT_VERSION,
    real: realStats,
    test: testStats,
  };
}

/** Resolves stored keys to display text for the admin detail view. */
async function getAdminSubmissionDetail(id) {
  const detail = await db.getSubmissionDetail(id);
  if (!detail) throw serviceError('NOT_FOUND', 'Submission not found', 404);
  const lang = detail.language;
  return {
    ...detail,
    primaryResult: content.resultForLanguage(detail.primaryPattern, lang),
    secondaryResult: detail.secondaryPattern ? content.resultForLanguage(detail.secondaryPattern, lang) : null,
    answers: detail.answers.map((a) => {
      const question = content.getQuestion(detail.department, a.questionKey);
      const option = content.getOption(detail.department, a.questionKey, a.optionKey);
      const patternBlock = content.getPatternResult(a.pattern);
      return {
        ...a,
        questionText: question ? question.text[lang] : a.questionKey,
        questionTextEn: question ? question.text.en : a.questionKey,
        optionText: option ? option.text[lang] : a.optionKey,
        optionTextEn: option ? option.text.en : a.optionKey,
        patternName: patternBlock ? patternBlock.name.en : a.pattern,
      };
    }),
  };
}

module.exports = {
  getMeta,
  getQuestionnaire,
  submitAssessment,
  getResultByToken,
  getPublicSummary,
  getAdminStatus,
  getAdminSubmissionDetail,
  listSubmissions: db.listSubmissions,
  setOpen: db.setOpen,
  deleteSubmission: db.deleteSubmission,
  clearSubmissions: db.clearSubmissions,
  PATTERNS,
  serviceError,
};
