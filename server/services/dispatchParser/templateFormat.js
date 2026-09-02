/**
 * Rendering the dispatch TEMPLATE, and deciding it is worth sending.
 *
 * `dispatchFieldsHaveCoreData` is the gate: a template with no pickup or no
 * delivery is a friendly failure message rather than a half-filled card sent to
 * a dispatcher, because a plausible-looking blank is worse than an honest "I
 * could not read this".
 *
 * Split out of server/services/dispatchParserService.js.
 */
const { DISPATCH_WARNING_LINES } = require('./constants');
const { stripMarkdownFences, sanitizeDispatchOutput } = require('./aiFailures');
const {
  normalizeDispatchValue, normalizeDispatchCity, normalizeDispatchMiles,
  normalizeDispatchRate,
} = require('./fieldNormalizers');
const {
  parseDispatchTemplate, mergeDispatchFields, sanitizeDispatchTemplateFields,
} = require('./fieldExtraction');
const { enrichWithMiles } = require('./miles');

function formatDispatchTemplate(fields) {
  const sanitized = sanitizeDispatchTemplateFields(fields);
  const outputFields = sanitized.cleaned;
  const loadedMiles = normalizeDispatchMiles(fields.loadedMiles);
  const totalMiles = normalizeDispatchMiles(fields.totalMiles);
  const rate = normalizeDispatchRate(fields.rate);
  const noteLines = [
    sanitized.pickupNotes.length > 0 ? `Pickup notes: ${sanitized.pickupNotes.join(' | ')}` : '',
    sanitized.deliveryNotes.length > 0 ? `Delivery notes: ${sanitized.deliveryNotes.join(' | ')}` : '',
  ].filter(Boolean);

  return [
    `Load type: ${normalizeDispatchValue(outputFields.loadType)}`,
    `Load #: ${normalizeDispatchValue(outputFields.loadNumber)}`,
    `PU # : ${normalizeDispatchValue(outputFields.puNumber)}`,
    `PO # : ${normalizeDispatchValue(outputFields.poNumber)}`,
    '',
    `PU : ${normalizeDispatchValue(outputFields.puDateTime)}`,
    normalizeDispatchValue(outputFields.pickupName),
    normalizeDispatchValue(outputFields.pickupStreet),
    normalizeDispatchCity(outputFields.pickupCity),
    '',
    `DEL : ${normalizeDispatchValue(outputFields.delDateTime)}`,
    normalizeDispatchValue(outputFields.deliveryName),
    normalizeDispatchValue(outputFields.deliveryStreet),
    normalizeDispatchCity(outputFields.deliveryCity),
    '',
    ...DISPATCH_WARNING_LINES,
    ...(noteLines.length > 0 ? ['', ...noteLines] : []),
    '',
    `Loaded miles : ${loadedMiles}`,
    `Total miles : ${totalMiles}`,
    `Rate: ${rate}`,
  ].join('\n').trim();
}

function dispatchTextHasEnoughData(text) {
  const fields = parseDispatchTemplate(text);
  const filledCount = countDispatchFilledFields(fields);
  return filledCount >= 8;
}

function countDispatchFilledFields(fields) {
  const filledCount = [
    fields.loadType,
    fields.loadNumber,
    fields.puNumber,
    fields.poNumber,
    fields.puDateTime,
    fields.pickupName,
    fields.pickupStreet,
    fields.pickupCity,
    fields.delDateTime,
    fields.deliveryName,
    fields.deliveryStreet,
    fields.deliveryCity,
    fields.loadedMiles,
    fields.totalMiles,
    fields.rate,
  ].filter(Boolean).length;
  return filledCount;
}

function dispatchFieldsHaveCoreData(fields) {
  return Boolean(
    normalizeDispatchValue(fields.loadNumber)
    && normalizeDispatchValue(fields.pickupName)
    && normalizeDispatchValue(fields.pickupStreet)
    && normalizeDispatchValue(fields.pickupCity)
    && normalizeDispatchValue(fields.deliveryName)
    && normalizeDispatchValue(fields.deliveryStreet)
    && normalizeDispatchValue(fields.deliveryCity)
  );
}

function buildFriendlyDispatchFailure(attemptErrors) {
  const failures = Array.isArray(attemptErrors) ? attemptErrors : [];
  const allUnauthorized = failures.length > 0 && failures.every((attempt) => (
    attempt.status === 400
    || attempt.status === 401
    || attempt.status === 403
    || /api key/i.test(attempt.message || '')
    || /permission denied/i.test(attempt.message || '')
  ));
  if (allUnauthorized) {
    return 'Dispatch parsing is temporarily unavailable because an AI provider API key is invalid.';
  }

  const hasTransientCapacityIssue = failures.some((attempt) => (
    attempt.status === 429
    || attempt.status === 503
    || /quota exceeded/i.test(attempt.message || '')
    || /high demand/i.test(attempt.message || '')
    || /try again later/i.test(attempt.message || '')
  ));
  if (hasTransientCapacityIssue) {
    return 'The AI parsing service is temporarily busy. Please try the same file again in about 30 seconds.';
  }

  return 'Could not fully parse that rate confirmation right now. Please try the PDF again or paste a clear screenshot.';
}

async function mergeDispatchTextWithParsedFields(parsedFields, aiText) {
  const cleanedText = sanitizeDispatchOutput(stripMarkdownFences(aiText));
  if (!dispatchTextHasEnoughData(cleanedText)) {
    throw new Error('AI provider returned an incomplete dispatch template');
  }

  const merged = mergeDispatchFields(parsedFields, parseDispatchTemplate(cleanedText));
  const enriched = await enrichWithMiles(merged);
  return formatDispatchTemplate(enriched);
}

module.exports = {
  formatDispatchTemplate,
  dispatchTextHasEnoughData,
  countDispatchFilledFields,
  dispatchFieldsHaveCoreData,
  buildFriendlyDispatchFailure,
  mergeDispatchTextWithParsedFields,
};
