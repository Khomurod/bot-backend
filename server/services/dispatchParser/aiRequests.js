/**
 * Asking a model to fill the dispatch template.
 *
 * Images are prepared by services/aiImagePrep.js before they are sent (EXIF
 * rotate, bounded dimensions, JPEG re-encode); a PDF passes through untouched.
 * Do NOT base64 a raw buffer here — a phone photo of a rate con is several
 * megabytes and base64 inflates it another third on the way out of Render.
 *
 * Split out of server/services/dispatchParserService.js.
 */
const { callGroqWithFallback } = require('../../../services/groqClient');
const { prepareImagePartForAi } = require('../../../services/aiImagePrep');
const {
  callGeminiGenerateContent, GEMINI_API_KEY,
} = require('../../../services/geminiClient');
const {
  DISPATCH_GROQ_MODEL, DISPATCH_GROQ_MODELS, DISPATCH_GEMINI_MODELS,
  DISPATCH_AI_SYSTEM_PROMPT, DISPATCH_SYSTEM_PROMPT_CLEAN, MAX_INLINE_GEMINI_FILE_BYTES,
} = require('./constants');
const { sanitizeDispatchOutput, safeParseJsonObject } = require('./aiFailures');
const { buildDispatchFieldsFromObject } = require('./fieldExtraction');
const { buildFriendlyDispatchFailure } = require('./templateFormat');

async function buildDispatchGeminiParts(rawText, sourceFile) {
  const parts = [];
  const canInlineSourceFile = Boolean(
    sourceFile?.buffer
    && sourceFile?.mimetype
    && (
      sourceFile.mimetype === 'application/pdf'
      || sourceFile.mimetype.startsWith('image/')
    )
    && sourceFile.buffer.length <= MAX_INLINE_GEMINI_FILE_BYTES
  );

  // An image is resized/re-encoded first; a PDF passes through untouched.
  if (canInlineSourceFile) {
    parts.push(await prepareImagePartForAi(sourceFile.buffer, sourceFile.mimetype));
  }

  const promptText = [
    canInlineSourceFile
      ? 'Use the attached document as the primary source of truth. Use the extracted text below only as a helper if the document text layer is noisy.'
      : 'Use the extracted text below as the source document.',
    'Return the completed template all the way through the final Rate line.',
    'Raw extracted text:',
    '<rate_confirmation>',
    rawText.slice(0, 12000),
    '</rate_confirmation>',
  ].join('\n');

  parts.push({ text: promptText });
  return parts;
}

function buildDispatchAiMessages(rawText) {
  return [
    {
      role: 'system',
      content: [
        'You are a trucking dispatch assistant that extracts load details from freight broker rate confirmations.',
        'Return a valid JSON object only. Do not include markdown, explanations, or any extra text.',
        'Use exactly these keys:',
        'loadType, loadNumber, puNumber, poNumber, puDateTime, pickupName, pickupStreet, pickupCity, delDateTime, deliveryName, deliveryStreet, deliveryCity, loadedMiles, totalMiles, rate',
        'Use empty strings for missing fields.',
        'For loadType, use the actual detected value only, such as LIVE, LIVE / LIVE, DROP AND HOOK, HOOK AND DROP, etc.',
        'For rate, return a dollar-formatted string when possible, for example $1,800.00.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        'Raw rate confirmation text:',
        '<rate_confirmation>',
        rawText.slice(0, 12000),
        '</rate_confirmation>',
      ].join('\n'),
    },
  ];
}

async function requestDispatchTemplateFromGroq(rawText) {
  try {
    const { text, model } = await callGroqWithFallback('', {
      messages: buildDispatchAiMessages(rawText),
      models: DISPATCH_GROQ_MODELS,
      temperature: 0,
      seed: 7,
      maxCompletionTokens: 400,
      responseFormat: { type: 'json_object' },
      validateResult: (raw) => (
        safeParseJsonObject(raw) ? true : { message: 'Groq returned invalid JSON for dispatch parsing' }
      ),
    });
    const parsedObject = safeParseJsonObject(text);
    return {
      model,
      fields: buildDispatchFieldsFromObject(parsedObject),
    };
  } catch (err) {
    const failure = new Error(buildFriendlyDispatchFailure(err.attemptErrors || []));
    failure.attemptErrors = err.attemptErrors || [{ model: DISPATCH_GROQ_MODEL, message: err.message }];
    throw failure;
  }
}

async function requestDispatchTemplateFromGemini(rawText, sourceFile) {
  if (!GEMINI_API_KEY) {
    const failure = new Error('GEMINI_API_KEY is not configured');
    failure.attemptErrors = [{ model: 'gemini', status: null, message: failure.message }];
    throw failure;
  }

  const contents = [{ parts: await buildDispatchGeminiParts(rawText, sourceFile) }];

  try {
    const { text, model } = await callGeminiGenerateContent({
      models: DISPATCH_GEMINI_MODELS,
      contents,
      systemInstruction: {
        parts: [{ text: DISPATCH_SYSTEM_PROMPT_CLEAN }],
      },
      generationConfig: {
        maxOutputTokens: 1000,
        responseMimeType: 'text/plain',
      },
      validateResult: (raw) => (String(raw || '').trim() ? true : { message: 'Gemini returned an empty response' }),
    });
    return { model, text };
  } catch (err) {
    const failure = new Error(buildFriendlyDispatchFailure(err.attemptErrors || []));
    failure.attemptErrors = err.attemptErrors || [{ model: 'gemini', message: err.message }];
    throw failure;
  }
}

module.exports = {
  requestDispatchTemplateFromGroq,
  requestDispatchTemplateFromGemini,
};
