/**
 * SOS assessment content — assembly and public serializers.
 *
 * All question/option/result text lives in these versioned code modules, NOT in
 * the database. Submissions snapshot option keys + pattern/weight + computed
 * result, so editing content never changes a stored result. Bump
 * CONTENT_VERSION on any change to question/option KEYS or PATTERN MAPPINGS
 * (pure wording fixes do not require a bump).
 *
 * SECURITY: `toPublicQuestions()` is a WHITELIST serializer — the public
 * questionnaire payload must never contain `pattern`/`weight`, otherwise the
 * scoring key would be visible in browser devtools. Enforced by
 * tests/sosContent.test.js.
 */

const { PATTERNS, LANGUAGES, DEPARTMENTS, DEPARTMENT_KEYS } = require('../constants');

const CONTENT_VERSION = 1;

const departments = {
  hr: require('./hr'),
  safety: require('./safety'),
  dispatch: require('./dispatch'),
  trailer: require('./trailer'),
  samsara: require('./samsara'),
  accounting: require('./accounting'),
  updaters: require('./updaters'),
};

const results = {
  victim: require('./results/victim'),
  complaint: require('./results/complaint'),
  waiting: require('./results/waiting'),
  blame: require('./results/blame'),
  ownership: require('./results/ownership'),
  builder: require('./results/builder'),
};

const resultCommon = require('./results/common');
const presentationUz = require('./presentationUz');

function getQuestions(departmentKey) {
  const dept = departments[departmentKey];
  return dept ? dept.questions : null;
}

function getQuestion(departmentKey, questionKey) {
  const questions = getQuestions(departmentKey);
  if (!questions) return null;
  return questions.find((q) => q.key === questionKey) || null;
}

function getOption(departmentKey, questionKey, optionKey) {
  const question = getQuestion(departmentKey, questionKey);
  if (!question) return null;
  return question.options.find((o) => o.key === optionKey) || null;
}

function getPatternResult(pattern) {
  return results[pattern] || null;
}

/**
 * Public questionnaire payload for /questions. WHITELIST serializer: emits
 * only key/position/text for questions and key/text for options. All three
 * languages are included so the employee can switch language without refetch.
 */
function toPublicQuestions(departmentKey) {
  const questions = getQuestions(departmentKey);
  if (!questions) return null;
  return questions.map((q, index) => ({
    key: q.key,
    position: index + 1,
    text: { uz: q.text.uz, ru: q.text.ru, en: q.text.en },
    options: q.options.map((o) => ({
      key: o.key,
      text: { uz: o.text.uz, ru: o.text.ru, en: o.text.en },
    })),
  }));
}

/** One pattern's result block in a single language (for the personal result). */
function resultForLanguage(pattern, language) {
  const block = results[pattern];
  if (!block || !LANGUAGES.includes(language)) return null;
  const pick = (t) => t[language];
  return {
    pattern,
    name: pick(block.name),
    headline: pick(block.headline),
    explanation: pick(block.explanation),
    strengths: block.strengths.map(pick),
    risks: block.risks.map(pick),
    techniques: block.techniques.map(pick),
    sosQuestions: block.sosQuestions.map(pick),
  };
}

/** Shared result-page strings in a single language. */
function resultCommonForLanguage(language) {
  if (!LANGUAGES.includes(language)) return null;
  const out = {};
  for (const [key, value] of Object.entries(resultCommon)) out[key] = value[language];
  return out;
}

/**
 * Content integrity check used by tests and (defensively) at server startup.
 * Returns an array of human-readable problems; empty array = valid.
 */
function validateContent() {
  const problems = [];
  const seenKeys = new Set();
  for (const deptKey of DEPARTMENT_KEYS) {
    const dept = departments[deptKey];
    if (!dept) { problems.push(`missing department module: ${deptKey}`); continue; }
    if (dept.department !== deptKey) problems.push(`${deptKey}: department field mismatch`);
    if (!Array.isArray(dept.questions) || dept.questions.length !== 10) {
      problems.push(`${deptKey}: expected exactly 10 questions`);
      continue;
    }
    const patternCounts = {};
    dept.questions.forEach((q, qi) => {
      if (!q.key || seenKeys.has(q.key)) problems.push(`${deptKey} q${qi + 1}: missing/duplicate key`);
      seenKeys.add(q.key);
      for (const lang of LANGUAGES) {
        if (!q.text || typeof q.text[lang] !== 'string' || !q.text[lang].trim()) {
          problems.push(`${q.key}: missing ${lang} question text`);
        }
      }
      if (!Array.isArray(q.options) || q.options.length !== 5) {
        problems.push(`${q.key}: expected exactly 5 options`);
        return;
      }
      const questionPatterns = new Set();
      q.options.forEach((o) => {
        if (!o.key || seenKeys.has(o.key)) problems.push(`${q.key}: missing/duplicate option key ${o.key}`);
        seenKeys.add(o.key);
        if (!PATTERNS.includes(o.pattern)) problems.push(`${o.key}: invalid pattern ${o.pattern}`);
        if (o.weight !== undefined && !(o.weight > 0 && o.weight <= 2)) {
          problems.push(`${o.key}: weight out of range`);
        }
        if (questionPatterns.has(o.pattern)) problems.push(`${q.key}: duplicate pattern ${o.pattern}`);
        questionPatterns.add(o.pattern);
        patternCounts[o.pattern] = (patternCounts[o.pattern] || 0) + 1;
        for (const lang of LANGUAGES) {
          if (!o.text || typeof o.text[lang] !== 'string' || !o.text[lang].trim()) {
            problems.push(`${o.key}: missing ${lang} option text`);
          }
        }
      });
      if (!questionPatterns.has('ownership')) problems.push(`${q.key}: no ownership option`);
      if (!questionPatterns.has('builder')) problems.push(`${q.key}: no builder option`);
    });
    for (const pattern of PATTERNS) {
      if (!patternCounts[pattern]) problems.push(`${deptKey}: pattern ${pattern} never used`);
    }
  }
  for (const pattern of PATTERNS) {
    const block = results[pattern];
    if (!block) { problems.push(`missing result block: ${pattern}`); continue; }
    for (const field of ['name', 'headline', 'explanation']) {
      for (const lang of LANGUAGES) {
        if (!block[field] || !block[field][lang] || !block[field][lang].trim()) {
          problems.push(`results/${pattern}.${field}: missing ${lang}`);
        }
      }
    }
    for (const listField of ['strengths', 'risks', 'techniques', 'sosQuestions']) {
      const list = block[listField];
      if (!Array.isArray(list) || list.length < 2) {
        problems.push(`results/${pattern}.${listField}: expected >= 2 entries`);
        continue;
      }
      list.forEach((entry, i) => {
        for (const lang of LANGUAGES) {
          if (!entry[lang] || !entry[lang].trim()) problems.push(`results/${pattern}.${listField}[${i}]: missing ${lang}`);
        }
      });
    }
  }
  return problems;
}

module.exports = {
  CONTENT_VERSION,
  DEPARTMENTS,
  DEPARTMENT_KEYS,
  departments,
  results,
  resultCommon,
  presentationUz,
  getQuestions,
  getQuestion,
  getOption,
  getPatternResult,
  toPublicQuestions,
  resultForLanguage,
  resultCommonForLanguage,
  validateContent,
};
