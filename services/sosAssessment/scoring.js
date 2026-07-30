/**
 * SOS assessment — pure, deterministic scoring.
 *
 * No AI, no randomness, no time dependence: the same answers always produce
 * the same result. Each selected option contributes its weight (default 1) to
 * exactly one pattern; primary = highest total, secondary = best remaining
 * pattern with a score > 0. Ties resolve by PATTERN_PRECEDENCE (constructive
 * patterns win), which keeps results kind and fully deterministic.
 */

const { PATTERNS, PATTERN_PRECEDENCE } = require('./constants');
const content = require('./content');

class SosValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SosValidationError';
    this.code = code;
    this.statusCode = 400;
  }
}

/**
 * Normalizes a full name for duplicate detection only (display keeps the
 * original): trims, unifies the Uzbek/typographic apostrophe variants, strips
 * combining marks and punctuation, lowercases, collapses whitespace.
 */
function normalizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[ʻʼ‘’`´]/g, "'")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/'+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickByPrecedence(candidates) {
  for (const pattern of PATTERN_PRECEDENCE) {
    if (candidates.includes(pattern)) return pattern;
  }
  return candidates[0] || null;
}

/**
 * Scores a full answer set for a department.
 *
 * @param {string} departmentKey
 * @param {Array<{questionKey: string, optionKey: string}>} answers
 * @returns {{scores: Object, primary: string, secondary: string|null,
 *            answerSnapshots: Array<{questionKey, optionKey, pattern, weight, position}>}}
 * @throws {SosValidationError} on unknown department/question/option keys,
 *         duplicate or missing answers.
 */
function scoreAnswers(departmentKey, answers) {
  const questions = content.getQuestions(departmentKey);
  if (!questions) throw new SosValidationError('UNKNOWN_DEPARTMENT', `unknown department: ${departmentKey}`);
  if (!Array.isArray(answers) || answers.length !== questions.length) {
    throw new SosValidationError('ANSWER_COUNT', `expected ${questions.length} answers`);
  }

  const byQuestion = new Map();
  for (const answer of answers) {
    if (!answer || typeof answer.questionKey !== 'string' || typeof answer.optionKey !== 'string') {
      throw new SosValidationError('ANSWER_SHAPE', 'each answer needs questionKey and optionKey');
    }
    if (byQuestion.has(answer.questionKey)) {
      throw new SosValidationError('DUPLICATE_ANSWER', `duplicate answer for ${answer.questionKey}`);
    }
    byQuestion.set(answer.questionKey, answer.optionKey);
  }

  const scores = {};
  for (const pattern of PATTERNS) scores[pattern] = 0;

  const answerSnapshots = questions.map((question, index) => {
    const optionKey = byQuestion.get(question.key);
    if (!optionKey) throw new SosValidationError('MISSING_ANSWER', `missing answer for ${question.key}`);
    const option = question.options.find((o) => o.key === optionKey);
    if (!option) throw new SosValidationError('UNKNOWN_OPTION', `unknown option ${optionKey} for ${question.key}`);
    const weight = option.weight === undefined ? 1 : option.weight;
    scores[option.pattern] += weight;
    return {
      questionKey: question.key,
      optionKey: option.key,
      pattern: option.pattern,
      weight,
      position: index + 1,
    };
  });

  const maxScore = Math.max(...PATTERNS.map((p) => scores[p]));
  const primary = pickByPrecedence(PATTERNS.filter((p) => scores[p] === maxScore));

  const remaining = PATTERNS.filter((p) => p !== primary && scores[p] > 0);
  let secondary = null;
  if (remaining.length > 0) {
    const maxRemaining = Math.max(...remaining.map((p) => scores[p]));
    secondary = pickByPrecedence(remaining.filter((p) => scores[p] === maxRemaining));
  }

  return { scores, primary, secondary, answerSnapshots };
}

module.exports = { scoreAnswers, normalizeName, SosValidationError };
