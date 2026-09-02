/**
 * Turning a rate confirmation's raw text into a load context.
 *
 * Runs the two providers and merges their answers (./aiExtraction.js does the
 * calling; ./rules.js decides how to merge and whether the result is complete).
 * Distinct from the reader chain in dispatchPinnedContextService.js, which picks
 * WHICH source to read; this is what to do once you have the text.
 *
 * Split out of services/dispatchPinnedContextService.js, which re-exports it.
 */
const { getPinnedContextGeminiModels, GEMINI_API_KEY } = require('../geminiClient');
const { truncateDispatchEtaLogMessage } = require('./constants');
const {
  normalizeLine, isLoadContextComplete, inferDestinationFromPinnedText,
  chooseBestDestinationQuery, mergeGroqGeminiAiResults, hasInlineVisualMedia,
} = require('./rules');
const {
  requestPinnedContextFromGroq, requestPinnedContextFromGemini,
} = require('./aiExtraction');

async function buildLoadContextFromText({
  pinnedText,
  extractedRawText = '',
  sourceFile = null,
  sourceFiles = null,
  sourceLabel = 'pinned-text+ai',
  interactive = false,
}) {
  const normalizedPinnedText = String(pinnedText || '').trim();
  const normalizedExtractedText = String(extractedRawText || '').trim();
  const aiStartMs = Date.now();
  const hasVisualMedia = hasInlineVisualMedia(sourceFile, sourceFiles);

  let groqResult = null;
  let geminiResult = null;

  const groqRequestOpts = {
    pinnedText: normalizedPinnedText,
    extractedRawText: normalizedExtractedText,
    interactive,
  };

  const geminiRequestOpts = {
    pinnedText: normalizedPinnedText,
    extractedRawText: normalizedExtractedText,
    interactive,
  };

  if (hasVisualMedia) {
    try {
      groqResult = await requestPinnedContextFromGroq(groqRequestOpts);
    } catch (err) {
      console.warn('[DISPATCH-ETA] Pinned-context Groq parse failed:', truncateDispatchEtaLogMessage(err.message));
    }

    try {
      const modelList = getPinnedContextGeminiModels().join(', ');
      console.log(`[DISPATCH-ETA] Pinned-context Gemini attempt (${modelList})`);
      geminiResult = await requestPinnedContextFromGemini({
        ...geminiRequestOpts,
        sourceFile: Array.isArray(sourceFiles) && sourceFiles.length > 0 ? null : sourceFile,
        sourceFiles: Array.isArray(sourceFiles) && sourceFiles.length > 0 ? sourceFiles : null,
      });
    } catch (err) {
      console.warn('[DISPATCH-ETA] Pinned-context Gemini parse failed:', truncateDispatchEtaLogMessage(err.message));
    }
  } else if (GEMINI_API_KEY) {
    const modelList = getPinnedContextGeminiModels().join(', ');
    console.log(`[DISPATCH-ETA] Pinned-context Gemini attempt (${modelList})`);

    const groqPromise = requestPinnedContextFromGroq(groqRequestOpts).catch((err) => {
      console.warn('[DISPATCH-ETA] Pinned-context Groq parse failed:', truncateDispatchEtaLogMessage(err.message));
      return null;
    });

    const geminiPromise = requestPinnedContextFromGemini({
      ...geminiRequestOpts,
      sourceFile: null,
      sourceFiles: null,
    }).catch((err) => {
      console.warn('[DISPATCH-ETA] Pinned-context Gemini parse failed:', truncateDispatchEtaLogMessage(err.message));
      return null;
    });

    groqResult = await groqPromise;
    if (!groqResult) {
      geminiResult = await geminiPromise;
    } else {
      geminiPromise.catch(() => {});
    }
  } else {
    try {
      groqResult = await requestPinnedContextFromGroq(groqRequestOpts);
    } catch (err) {
      console.warn('[DISPATCH-ETA] Pinned-context Groq parse failed:', truncateDispatchEtaLogMessage(err.message));
    }
  }

  let aiResult = groqResult;
  let provider = 'none';
  if (groqResult && geminiResult) {
    aiResult = mergeGroqGeminiAiResults(groqResult, geminiResult);
    provider = 'merged';
  } else if (geminiResult) {
    aiResult = geminiResult;
    provider = 'gemini';
  } else if (groqResult) {
    aiResult = groqResult;
    provider = 'groq';
  }

  console.log(
    `[DISPATCH-ETA] Pinned-context AI result: provider=${provider} model=${aiResult?.model || 'none'} in ${Date.now() - aiStartMs}ms`
  );

  const fallbackDestination = inferDestinationFromPinnedText(
    [normalizedPinnedText, normalizedExtractedText].filter(Boolean).join('\n')
  );
  const pickupSummary = normalizeLine(aiResult?.fields?.pickupLocation || '');
  const pickupDateTime = normalizeLine(aiResult?.fields?.pickupDateTime || '');
  const deliverySummary = normalizeLine(aiResult?.fields?.deliveryLocation || '');
  const deliveryDateTime = normalizeLine(aiResult?.fields?.deliveryDateTime || '');
  const destinationQuery = chooseBestDestinationQuery({
    aiDestination: aiResult?.fields?.destinationQuery || '',
    pickupLocation: pickupSummary,
    deliveryLocation: deliverySummary,
    fallbackDestination,
  });

  const pickupSummaryLine = [pickupSummary, pickupDateTime].filter(Boolean).join(' | ');
  const deliverySummaryLine = [deliverySummary, deliveryDateTime].filter(Boolean).join(' | ');

  const aiFieldsJson = aiResult
    ? {
        pickup_location: aiResult.fields.pickupLocation,
        pickup_datetime: aiResult.fields.pickupDateTime,
        delivery_location: aiResult.fields.deliveryLocation,
        delivery_datetime: aiResult.fields.deliveryDateTime,
        destination_query: aiResult.fields.destinationQuery,
        notes: aiResult.fields.notes,
      }
    : null;

  return {
    pickupSummary: pickupSummaryLine,
    deliverySummary: deliverySummaryLine,
    destinationQuery,
    source: sourceLabel,
    pinnedText: normalizedPinnedText,
    aiModel: aiResult?.model || '',
    extractedRawText: normalizedExtractedText,
    pickupDateTimeRaw: pickupDateTime,
    deliveryDateTimeRaw: deliveryDateTime,
    aiFieldsJson,
    loadInfoComplete: isLoadContextComplete({
      pickupSummary: pickupSummaryLine,
      deliverySummary: deliverySummaryLine,
      destinationQuery,
    }),
  };
}

module.exports = {
  buildLoadContextFromText,
};
