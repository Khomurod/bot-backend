/**
 * Pinned-context DECISION RULES — pure functions, no I/O.
 *
 * Which pinned message to trust, whether a candidate destination is too weak to
 * route on, whether a load context is complete enough to answer with, and how to
 * merge the Groq and Gemini answers. A weak destination is the sharp edge: it is
 * better to say nothing than to give a driver the wrong stop.
 *
 * Split out of services/dispatchPinnedContextService.js, which re-exports the
 * ones its tests assert on.
 */
const {
  STALE_STATUS_CHAT_MESSAGE_REGEX, MAX_INLINE_GEMINI_FILE_BYTES,
} = require('./constants');

function normalizeLine(line) {
  return String(line || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isLikelyStaleStatusMessage(text) {
  const source = String(text || '');
  return STALE_STATUS_CHAT_MESSAGE_REGEX.test(source);
}

function isLoadContextComplete(context) {
  return Boolean(
    normalizeLine(context?.pickupSummary)
    && normalizeLine(context?.deliverySummary)
    && normalizeLine(context?.destinationQuery)
  );
}

function stripJsonFences(text) {
  return String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function safeParseJsonObject(text) {
  const raw = stripJsonFences(text);
  try {
    const direct = JSON.parse(raw);
    if (direct && typeof direct === 'object' && !Array.isArray(direct)) return direct;
  } catch {
    // continue
  }

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const slice = raw.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(slice);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // ignore
    }
  }

  return null;
}

function inferDestinationFromPinnedText(text) {
  const source = String(text || '');
  const cityZipMatches = Array.from(
    source.matchAll(/\b([A-Za-z.' -]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)\b/g)
  ).map((match) => normalizeLine(match[1]));
  if (cityZipMatches.length > 0) return cityZipMatches[cityZipMatches.length - 1];

  const plainMatches = Array.from(
    source.matchAll(/\b([A-Za-z.' -]+\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)\b/g)
  ).map((match) => normalizeLine(match[1]));
  if (plainMatches.length > 0) return plainMatches[plainMatches.length - 1];

  const stateRoute = source.match(/\b([A-Z]{2})\s*>\s*([A-Z]{2})\b/i);
  if (stateRoute) return `${stateRoute[2].toUpperCase()}, USA`;

  return '';
}

function getPinnedMessageDate(message) {
  const unix = Number(message?.date || 0);
  return Number.isFinite(unix) && unix > 0 ? unix : 0;
}

function choosePinnedMessageCandidate({
  chatPinnedMessage,
  snapshotPinnedMessage,
  snapshotSourceEventAt,
}) {
  if (!snapshotPinnedMessage) return chatPinnedMessage || null;
  if (!chatPinnedMessage) return snapshotPinnedMessage;

  if (snapshotPinnedMessage.message_id === chatPinnedMessage.message_id) {
    return chatPinnedMessage;
  }

  const snapshotEventMs = Date.parse(String(snapshotSourceEventAt || ''));
  if (Number.isFinite(snapshotEventMs)) {
    return snapshotPinnedMessage;
  }

  const chatDate = getPinnedMessageDate(chatPinnedMessage);
  const snapshotDate = getPinnedMessageDate(snapshotPinnedMessage);
  if (snapshotDate >= chatDate) return snapshotPinnedMessage;
  return chatPinnedMessage;
}

function cleanDestinationCandidate(value) {
  return normalizeLine(value)
    .replace(/\|\s*[^|]*$/g, '')
    .replace(/\b(?:appt|appointment)\b.*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isWeakDestinationQuery(value) {
  const text = cleanDestinationCandidate(value).toLowerCase();
  if (!text) return true;
  if (text.length < 6) return true;
  if (text === 'usa') return true;
  if (text.includes('street address')) return true;
  if (text.includes('unknown')) return true;
  return false;
}

function chooseBestDestinationQuery({
  aiDestination,
  pickupLocation,
  deliveryLocation,
  fallbackDestination,
}) {
  const aiCandidate = cleanDestinationCandidate(aiDestination);
  const pickupCandidate = cleanDestinationCandidate(pickupLocation);
  const deliveryCandidate = cleanDestinationCandidate(deliveryLocation);
  const fallbackCandidate = cleanDestinationCandidate(fallbackDestination);

  const aiLooksLikePickup = Boolean(
    aiCandidate
    && pickupCandidate
    && aiCandidate.toLowerCase() === pickupCandidate.toLowerCase()
    && (!deliveryCandidate || aiCandidate.toLowerCase() !== deliveryCandidate.toLowerCase())
  );

  if (!isWeakDestinationQuery(aiCandidate) && !aiLooksLikePickup) {
    return aiCandidate;
  }
  if (!isWeakDestinationQuery(deliveryCandidate)) {
    return deliveryCandidate;
  }
  if (!isWeakDestinationQuery(fallbackCandidate)) {
    return fallbackCandidate;
  }

  return aiCandidate || deliveryCandidate || fallbackCandidate;
}

function mergeGroqGeminiAiResults(groq, gemini) {
  if (!groq) return gemini;
  if (!gemini) return groq;
  const r = groq.fields || {};
  const g = gemini.fields || {};
  const longer = (a, b) => {
    const na = normalizeLine(a || '');
    const nb = normalizeLine(b || '');
    if (nb.length > na.length) return nb;
    return na || nb;
  };
  return {
    model: `${groq.model || ''}+${gemini.model || ''}`,
    fields: {
      pickupLocation: longer(r.pickupLocation, g.pickupLocation),
      pickupDateTime: longer(r.pickupDateTime, g.pickupDateTime),
      deliveryLocation: longer(r.deliveryLocation, g.deliveryLocation),
      deliveryDateTime: longer(r.deliveryDateTime, g.deliveryDateTime),
      destinationQuery: longer(r.destinationQuery, g.destinationQuery),
      notes: longer(r.notes, g.notes),
    },
  };
}

function mapPinnedContextFields(parsed) {
  return {
    pickupLocation: normalizeLine(parsed.pickup_location || ''),
    pickupDateTime: normalizeLine(parsed.pickup_datetime || ''),
    deliveryLocation: normalizeLine(parsed.delivery_location || ''),
    deliveryDateTime: normalizeLine(parsed.delivery_datetime || ''),
    destinationQuery: normalizeLine(parsed.destination_query || ''),
    notes: normalizeLine(parsed.notes || ''),
  };
}

function hasInlineVisualMedia(sourceFile, sourceFiles) {
  const okFile = (f) =>
    Boolean(
      f?.buffer
        && f?.mimetype
        && (f.mimetype === 'application/pdf' || f.mimetype.startsWith('image/'))
        && f.buffer.length <= MAX_INLINE_GEMINI_FILE_BYTES
    );
  if (okFile(sourceFile)) return true;
  if (Array.isArray(sourceFiles)) {
    return sourceFiles.some((s) => okFile(s));
  }
  return false;
}

module.exports = {
  normalizeLine,
  isLikelyStaleStatusMessage,
  isLoadContextComplete,
  stripJsonFences,
  safeParseJsonObject,
  inferDestinationFromPinnedText,
  choosePinnedMessageCandidate,
  chooseBestDestinationQuery,
  mergeGroqGeminiAiResults,
  mapPinnedContextFields,
  hasInlineVisualMedia,
};
