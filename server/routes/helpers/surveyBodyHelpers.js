/**
 * What a new survey must contain before it is stored — the questions route's
 * only caller, kept next to it (see lib/README.md: one caller, no lib/ module).
 *
 * A survey goes to every active driver group IN THAT GROUP'S LANGUAGE, and a
 * driver answers by tapping one of its buttons (responses store an option id,
 * never text). So every one of the three languages needs the question and
 * every option, none of them blank — a blank Uzbek option is a blank button in
 * an Uzbek group — and there must be a real choice: at least two options.
 */
const SURVEY_LANGUAGES = ['en', 'ru', 'uz'];
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;

const filled = (value) => typeof value === 'string' && value.trim() !== '';

function textFor(list, language, field) {
  if (!Array.isArray(list)) return null;
  const row = list.find((t) => t && t.language === language);
  return row && filled(row[field]) ? row[field].trim() : null;
}

/**
 * Returns `{ error }` when the body is not a complete survey, otherwise
 * `{ translations, options }` trimmed and in the shape `createQuestion` takes,
 * with options numbered 1..n in the order given.
 */
function normalizeSurveyBody(body) {
  const { translations, options } = body || {};
  const questionTexts = SURVEY_LANGUAGES.map((language) => textFor(translations, language, 'question_text'));
  if (questionTexts.some((t) => t === null)) {
    return { error: 'The question is required in English, Russian and Uzbek.' };
  }
  if (!Array.isArray(options) || options.length < MIN_OPTIONS) {
    return { error: `A survey needs at least ${MIN_OPTIONS} answer options.` };
  }
  if (options.length > MAX_OPTIONS) {
    return { error: `A survey can have at most ${MAX_OPTIONS} answer options.` };
  }
  const normalizedOptions = [];
  for (let i = 0; i < options.length; i++) {
    const texts = SURVEY_LANGUAGES.map((language) => textFor(options[i]?.translations, language, 'option_text'));
    if (texts.some((t) => t === null)) {
      return { error: `Option ${i + 1} needs text in English, Russian and Uzbek.` };
    }
    normalizedOptions.push({
      option_order: i + 1,
      translations: SURVEY_LANGUAGES.map((language, j) => ({ language, option_text: texts[j] })),
    });
  }
  return {
    translations: SURVEY_LANGUAGES.map((language, j) => ({ language, question_text: questionTexts[j] })),
    options: normalizedOptions,
  };
}

module.exports = { normalizeSurveyBody, SURVEY_LANGUAGES, MIN_OPTIONS, MAX_OPTIONS };
