/**
 * Asking a model to read the load context out of a rate confirmation.
 *
 * Two providers, tried in an order the caller decides: Gemini first when the
 * extracted text is weak or came from PDF OCR, otherwise Groq first. Neither is
 * a fallback for the other automatically — see APP_BRIEF §6.
 *
 * Images are prepared by services/aiImagePrep.js before they are sent (EXIF
 * rotate, bounded dimensions, re-encoded); PDFs pass through untouched. Do not
 * base64 a raw buffer here.
 *
 * Split out of services/dispatchPinnedContextService.js.
 */
const { callGroqWithFallback, INTERACTIVE_MAX_RETRY_WAIT_MS } = require('../groqClient');
const { prepareImagePartForAi } = require('../aiImagePrep');
const {
  callGeminiGenerateContent, getPinnedContextGeminiModels,
} = require('../geminiClient');
const {
  PINNED_CONTEXT_GROQ_MODELS, INTERACTIVE_GEMINI_MAX_RETRY_WAIT_MS,
  INTERACTIVE_GROQ_TIMEOUT_MS, MAX_INLINE_GEMINI_FILE_BYTES, MAX_ALBUM_INLINE_PARTS,
} = require('./constants');
const { stripJsonFences, safeParseJsonObject, mapPinnedContextFields } = require('./rules');

function buildPinnedContextPrompt({ pinnedText, extractedRawText, multipleMedia = false }) {
  const lines = [
    'You are a trucking dispatch assistant.',
    'Pinned Telegram load messages can be messy and inconsistent. Do not assume a fixed template.',
  ];
  if (multipleMedia) {
    lines.push(
      'Multiple images or PDF pages may belong to ONE load (album, screenshots, or multi-page). Read ALL media together and return ONE coherent pickup/delivery.'
    );
  }
  lines.push(
    'Answer these exact questions based on all provided content:',
    '1) What is the pickup location and pickup date/time?',
    '2) What is the delivery location and delivery date/time?',
    'Return JSON only with keys:',
    'pickup_location, pickup_datetime, delivery_location, delivery_datetime, destination_query, notes',
    'Rules:',
    '- If unknown, use empty string.',
    '- destination_query should be the best destination text for geocoding (prefer full street + city/state/zip).',
    '- No markdown, no explanation text.',
    '',
    'Pinned message text:',
    '<pinned_text>',
    pinnedText.slice(0, 6000),
    '</pinned_text>',
    '',
    'Extracted file text (if available):',
    '<extracted_file_text>',
    extractedRawText.slice(0, 10000),
    '</extracted_file_text>'
  );
  return lines.join('\n');
}

async function buildPinnedContextAiParts({
  pinnedText,
  extractedRawText,
  sourceFile,
  sourceFiles,
}) {
  const parts = [];
  const multi = Array.isArray(sourceFiles) && sourceFiles.length > 1;
  const prompt = buildPinnedContextPrompt({
    pinnedText,
    extractedRawText,
    multipleMedia: multi,
  });

  const inlineCandidates = [];
  if (Array.isArray(sourceFiles) && sourceFiles.length > 0) {
    for (const sf of sourceFiles.slice(0, MAX_ALBUM_INLINE_PARTS)) {
      if (!sf?.buffer || !sf?.mimetype) continue;
      if (sf.buffer.length > MAX_INLINE_GEMINI_FILE_BYTES) continue;
      if (!(sf.mimetype === 'application/pdf' || sf.mimetype.startsWith('image/'))) continue;
      inlineCandidates.push(sf);
    }
  } else if (
    sourceFile?.buffer
    && sourceFile?.mimetype
    && (sourceFile.mimetype === 'application/pdf' || sourceFile.mimetype.startsWith('image/'))
    && sourceFile.buffer.length <= MAX_INLINE_GEMINI_FILE_BYTES
  ) {
    inlineCandidates.push(sourceFile);
  }

  // Images are resized/re-encoded first; PDFs pass through untouched.
  for (const sf of inlineCandidates) {
    parts.push(await prepareImagePartForAi(sf.buffer, sf.mimetype));
  }

  parts.push({ text: prompt });
  return parts;
}

function buildPinnedContextGroqMessages({ pinnedText, extractedRawText }) {
  return [
    {
      role: 'system',
      content: 'You are a trucking dispatch assistant. Return a JSON object only. No markdown or extra text.',
    },
    {
      role: 'user',
      content: buildPinnedContextPrompt({ pinnedText, extractedRawText }),
    },
  ];
}

async function requestPinnedContextFromGroq({ pinnedText, extractedRawText, interactive = false }) {
  const messages = buildPinnedContextGroqMessages({ pinnedText, extractedRawText });
  const groqOpts = {
    messages,
    models: PINNED_CONTEXT_GROQ_MODELS,
    temperature: 0,
    seed: 7,
    maxCompletionTokens: 700,
    responseFormat: { type: 'json_object' },
    validateResult: (raw) => (safeParseJsonObject(raw) ? true : { message: 'Groq returned non-JSON output' }),
  };
  if (interactive) {
    groqOpts.maxRetryWaitMs = INTERACTIVE_MAX_RETRY_WAIT_MS;
    groqOpts.timeoutMs = INTERACTIVE_GROQ_TIMEOUT_MS;
  }
  const { text, model } = await callGroqWithFallback('', groqOpts);
  const parsed = safeParseJsonObject(text);
  return { model, fields: mapPinnedContextFields(parsed) };
}

async function requestPinnedContextFromGemini({
  pinnedText,
  extractedRawText,
  sourceFile,
  sourceFiles,
  interactive = false,
}) {
  const contents = [
    {
      parts: await buildPinnedContextAiParts({
        pinnedText,
        extractedRawText,
        sourceFile,
        sourceFiles,
      }),
    },
  ];

  const geminiOpts = {
    models: getPinnedContextGeminiModels(),
    contents,
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 800,
      responseMimeType: 'text/plain',
    },
    validateResult: (raw) => (safeParseJsonObject(raw) ? true : { message: 'Gemini returned non-JSON output' }),
  };
  if (interactive) {
    geminiOpts.maxRetryWaitMs = INTERACTIVE_GEMINI_MAX_RETRY_WAIT_MS;
  }

  const { text, model } = await callGeminiGenerateContent(geminiOpts);

  const parsed = safeParseJsonObject(text);
  return { model, fields: mapPinnedContextFields(parsed) };
}

module.exports = {
  buildPinnedContextPrompt,
  buildPinnedContextAiParts,
  buildPinnedContextGroqMessages,
  requestPinnedContextFromGroq,
  requestPinnedContextFromGemini,
};
