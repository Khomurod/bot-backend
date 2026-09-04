/**
 * Turning raw rate-confirmation text into the finished dispatch card.
 *
 * Runs the deterministic parser and the two AI providers, merges the results
 * field-by-field, enriches miles, and renders the template — or returns a
 * friendly failure when the core fields could not be read.
 *
 * Split out of server/services/dispatchParserService.js.
 */
const { DISPATCH_GROQ_MODEL, MAX_INLINE_GEMINI_FILE_BYTES } = require('./constants');
const { isWeakDispatchRawText } = require('./textExtraction');
const { safeParseJsonObject } = require('./aiFailures');
const {
  extractDispatchFields, parseDispatchTemplate, mergeDispatchFields,
  sanitizeDispatchTemplateFields, buildDispatchFieldsFromObject,
} = require('./fieldExtraction');
const {
  formatDispatchTemplate, dispatchTextHasEnoughData, countDispatchFilledFields,
  dispatchFieldsHaveCoreData, buildFriendlyDispatchFailure,
  mergeDispatchTextWithParsedFields,
} = require('./templateFormat');
const { enrichWithMiles } = require('./miles');
const {
  requestDispatchTemplateFromGroq, requestDispatchTemplateFromGemini,
} = require('./aiRequests');

async function formatDispatchRateConfirmation(rawText, sourceFile, options = {}) {
  const usedPdfOcr = Boolean(options.usedPdfOcr);
  const parsedFields = extractDispatchFields(rawText);
  const deterministicText = formatDispatchTemplate(parsedFields);
  const deterministicIsUsable = dispatchFieldsHaveCoreData(parsedFields) && dispatchTextHasEnoughData(deterministicText);
  const attemptErrors = [];
  const canUseInlineVisionSource = Boolean(
    sourceFile?.buffer
    && sourceFile?.mimetype
    && (
      sourceFile.mimetype === 'application/pdf'
      || sourceFile.mimetype.startsWith('image/')
    )
    && sourceFile.buffer.length <= MAX_INLINE_GEMINI_FILE_BYTES
  );
  const preferGeminiFirst = canUseInlineVisionSource && (isWeakDispatchRawText(rawText) || usedPdfOcr);

  async function tryGroq() {
    try {
      const groqResult = await requestDispatchTemplateFromGroq(rawText);
      const merged = mergeDispatchFields(parsedFields, groqResult.fields);
      const enriched = await enrichWithMiles(merged);
      const formattedText = formatDispatchTemplate(enriched);
      if (!dispatchTextHasEnoughData(formattedText)) {
        throw new Error('Groq returned an incomplete dispatch template');
      }
      return {
        model: groqResult.model,
        text: formattedText,
      };
    } catch (err) {
      if (Array.isArray(err?.attemptErrors) && err.attemptErrors.length > 0) {
        err.attemptErrors.forEach((attempt) => {
          attemptErrors.push({
            provider: 'groq',
            model: attempt.model,
            status: attempt.status || null,
            message: attempt.message,
          });
        });
      } else {
        attemptErrors.push({
          provider: 'groq',
          model: DISPATCH_GROQ_MODEL,
          status: err.status || null,
          message: err?.error?.message || err.message,
        });
      }
      return null;
    }
  }

  async function tryGemini() {
    try {
      const geminiResult = await requestDispatchTemplateFromGemini(rawText, sourceFile);
      return {
        model: geminiResult.model,
        text: await mergeDispatchTextWithParsedFields(parsedFields, geminiResult.text),
      };
    } catch (err) {
      if (Array.isArray(err?.attemptErrors) && err.attemptErrors.length > 0) {
        err.attemptErrors.forEach((attempt) => {
          attemptErrors.push({
            provider: 'gemini',
            model: attempt.model,
            status: attempt.status || null,
            message: attempt.message,
          });
        });
      } else {
        attemptErrors.push({
          provider: 'gemini',
          model: 'gemini',
          status: err.status || null,
          message: err?.error?.message || err.message,
        });
      }
      return null;
    }
  }

  if (preferGeminiFirst) {
    const geminiFirstResult = await tryGemini();
    if (geminiFirstResult) return geminiFirstResult;

    const groqSecondResult = await tryGroq();
    if (groqSecondResult) return groqSecondResult;
  } else {
    const groqFirstResult = await tryGroq();
    if (groqFirstResult) return groqFirstResult;

    const geminiSecondResult = await tryGemini();
    if (geminiSecondResult) return geminiSecondResult;
  }

  if (deterministicIsUsable) {
    return {
      model: 'deterministic-parser',
      text: deterministicText,
      fallback: true,
    };
  }

  const deterministicFallbackCount = countDispatchFilledFields(parseDispatchTemplate(deterministicText));
  if (deterministicFallbackCount >= 6) {
    return {
      model: 'deterministic-parser',
      text: deterministicText,
      fallback: true,
    };
  }

  const failure = new Error(buildFriendlyDispatchFailure(attemptErrors));
  failure.attemptErrors = attemptErrors;
  throw failure;
}

module.exports = {
  formatDispatchRateConfirmation,
};
