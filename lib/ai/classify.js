/**
 * What kind of "no" did a provider just say? PURE — no I/O, no state.
 *
 * A router is only as good as this function. Every decision it makes — try the
 * next model, try the next provider, wait, stop asking this provider until
 * tomorrow, stop asking until a human fixes something — comes from classifying
 * one failure, and getting the class wrong is expensive in both directions: too
 * eager and Wenze burns a free tier on requests that were never going to
 * succeed; too cautious and a five-second blip takes a provider offline for a
 * day.
 *
 * FOUR CLASSES, because they want four different responses.
 *
 *   TRANSIENT — 429 with no quota language, 503, any 5xx, a timeout, a socket
 *   error. The provider is fine and busy. Wait briefly, then try again or move
 *   on. `services/groqClient.js` already treats these correctly; this is that
 *   logic named and made testable.
 *
 *   QUOTA — a limit that resets on a clock: "quota", "resource_exhausted",
 *   "daily limit exceeded". Retrying inside the window is pure waste, and on a
 *   free tier it is the difference between one wasted call and several hundred.
 *   Cool the provider until the stated reset, or the end of the UTC day.
 *
 *   CREDENTIAL — 401, 403, "invalid api key", "not configured". No amount of
 *   waiting fixes this; only a person does. Cool the provider until an admin
 *   touches it.
 *
 *   FATAL_REQUEST — 400, 404, 422: the REQUEST is wrong, not the provider. A
 *   model name that no longer exists, a payload the API rejects. Moving to the
 *   next provider is right, but it says nothing bad about this one, so it must
 *   NOT cool it down. Missing this class is how one bad model name in a chain
 *   would take a healthy provider offline.
 *
 * THE DEFECT THIS FIXES. `groqClient.isAuthOrConfigError` treats 401/403 as
 * fatal and ABORTS THE WHOLE CHAIN. With one provider that was defensible — a
 * dead key fails identically on every model, so trying the rest is wasted
 * latency. With several providers it is plainly wrong: a dead key on provider A
 * says nothing whatsoever about provider B, and aborting there turns one
 * expired credential into a total AI outage. Here CREDENTIAL is `retryable:
 * false` for the SAME provider and `nextProvider: true` for the run.
 *
 * The status list is seeded from what the two existing clients already detect
 * (`isGroqRateLimitError`, `isGeminiQuotaExhaustedError`,
 * `isGeminiTransientError`), so nothing Wenze handles today is lost.
 */

const FAILURE = {
  TRANSIENT: 'transient',
  QUOTA: 'quota',
  CREDENTIAL: 'credential',
  FATAL_REQUEST: 'fatal_request',
  /**
   * The MODEL is gone — decommissioned, renamed, unknown to this account. A
   * subset of FATAL_REQUEST worth its own name because it is the one worth
   * REMEMBERING: the next model of the same provider is the right move now,
   * and the maintenance job should confirm against the listing and retire it.
   */
  MODEL: 'model',
  /** The call returned, but the answer was unusable — see below. */
  INVALID_RESPONSE: 'invalid_response',
  UNKNOWN: 'unknown',
};

/** Statuses that mean "busy, ask again". */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
/** Statuses that mean "your request is wrong", not "we are unwell". */
const FATAL_REQUEST_STATUS = new Set([400, 404, 405, 413, 414, 422, 501]);

const QUOTA_PATTERNS = [
  /quota/i, /resource[_\s-]?exhausted/i, /daily limit/i, /monthly limit/i,
  /limit exceeded/i, /exceeded your current/i, /out of credits/i,
  /insufficient[_\s-]?quota/i, /billing/i,
];

const CREDENTIAL_PATTERNS = [
  /invalid api key/i, /incorrect api key/i, /unauthorized/i, /forbidden/i,
  /not configured/i, /authentication/i, /api key not valid/i, /permission denied/i,
];

/** Groq: "has been decommissioned"; OpenAI-shape: model_not_found; Gemini: "is not found for API version". */
const MODEL_PATTERNS = [
  /model[_\s-]?not[_\s-]?found/i, /decommissioned/i, /no longer supported/i, /is deprecated/i,
  /unknown model/i, /invalid model/i, /model .{0,80}(does not exist|not found|is not found)/i,
  /models\/[\w.-]+ is not found/i, /not supported for generateContent/i,
];

const TRANSIENT_PATTERNS = [
  /rate limit/i, /too many requests/i, /service unavailable/i, /try again/i,
  /overloaded/i, /high demand/i, /temporarily unavailable/i, /timeout/i,
  /timed out/i, /ECONNRESET/i, /ETIMEDOUT/i, /ENOTFOUND/i, /EAI_AGAIN/i,
  /socket hang up/i, /fetch failed/i, /network/i,
];

function anyMatch(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/**
 * Classify one provider failure.
 *
 * ORDER MATTERS, and this is the ordering argument:
 *
 *   Quota language is checked BEFORE the transient status set, because a quota
 *   exhaustion arrives as a 429 and 429 is in that set. Reading the status
 *   first would classify "you have used your free tier for today" as "we are
 *   busy, try again in a second" — and Wenze would then spend the rest of the
 *   day retrying a provider that has already said no.
 *
 *   Credential language is checked before everything, because a 403 carrying
 *   "quota" in its body is a billing problem a person fixes, not a clock.
 *
 * @param {object} failure
 * @param {number|null} [failure.status]   HTTP status, if there was one
 * @param {string} [failure.message]       the error text
 * @param {*} [failure.code]               a socket error code, if any
 * @returns {{kind: string, retryable: boolean, nextProvider: boolean, coolProvider: boolean}}
 */
function classifyFailure({ status = null, message = '', code = null } = {}) {
  const text = `${message || ''} ${code || ''}`.trim();
  const numericStatus = Number.isFinite(Number(status)) ? Number(status) : null;

  if (numericStatus === 401 || numericStatus === 403 || anyMatch(CREDENTIAL_PATTERNS, text)) {
    return {
      kind: FAILURE.CREDENTIAL,
      // Never against the same provider: only a person changes a dead key.
      retryable: false,
      // ALWAYS onward. This is the one that used to abort the whole chain.
      nextProvider: true,
      coolProvider: true,
    };
  }

  if (anyMatch(QUOTA_PATTERNS, text)) {
    return {
      kind: FAILURE.QUOTA, retryable: false, nextProvider: true, coolProvider: true,
    };
  }

  // Model language BEFORE the generic request-fault set: both arrive as a
  // 400/404, and only one of them should change what Wenze asks for next time.
  if (anyMatch(MODEL_PATTERNS, text)
      && (numericStatus === null || FATAL_REQUEST_STATUS.has(numericStatus))) {
    return {
      kind: FAILURE.MODEL,
      retryable: false,
      // The next MODEL of this provider, not the next provider: the provider is
      // fine, one name in its chain is stale.
      nextProvider: false,
      coolProvider: false,
      skipModel: true,
    };
  }

  if (numericStatus !== null && FATAL_REQUEST_STATUS.has(numericStatus)) {
    return {
      kind: FAILURE.FATAL_REQUEST,
      retryable: false,
      nextProvider: true,
      // The provider is healthy — our request was not. Cooling it here would
      // let one stale model name disable a working provider.
      coolProvider: false,
    };
  }

  if ((numericStatus !== null && (TRANSIENT_STATUS.has(numericStatus) || numericStatus >= 500))
      || anyMatch(TRANSIENT_PATTERNS, text)) {
    return {
      kind: FAILURE.TRANSIENT, retryable: true, nextProvider: true, coolProvider: true,
    };
  }

  // Unrecognised: move on, but do not punish a provider for a message this
  // function has not been taught yet.
  return {
    kind: FAILURE.UNKNOWN, retryable: false, nextProvider: true, coolProvider: false,
  };
}

/**
 * A response that arrived but cannot be used — empty text, unparseable JSON, a
 * capability's own validator saying no.
 *
 * Treated as a provider failure ON PURPOSE. Handing a consumer malformed output
 * is worse than trying the next provider, and this matters far more with
 * several free models than it did with one: they differ widely in how reliably
 * they honour a JSON instruction. `groqClient`'s `validateResult` hook already
 * falls through to the next model on exactly this; the router promotes it to
 * fall through to the next PROVIDER.
 *
 * Never cools the provider: a model that answered badly once is not unwell.
 */
function invalidResponse(reason) {
  return {
    kind: FAILURE.INVALID_RESPONSE,
    retryable: false,
    nextProvider: true,
    coolProvider: false,
    reason: reason || 'Response failed validation',
  };
}

/**
 * How long to wait before the next attempt, in ms.
 *
 * Header-then-body, the union of what both existing clients parse: Groq says
 * "try again in 1.5s" in the body, Gemini says "retry in 2s". Capped by the
 * caller's ceiling so a provider cannot ask Wenze to sleep for an hour.
 */
function retryAfterMs({ headerValue = null, message = '', maxMs = 35000 } = {}) {
  const fromHeader = Number(headerValue);
  if (Number.isFinite(fromHeader) && fromHeader > 0) {
    return Math.min(Math.ceil(fromHeader * 1000), maxMs);
  }
  const match = String(message || '').match(/(?:try again|retry)\s+in\s+([\d.]+)\s*(m?s)?/i);
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) {
      const ms = match[2] && match[2].toLowerCase() === 'ms' ? value : value * 1000;
      return Math.min(Math.ceil(ms), maxMs);
    }
  }
  return 0;
}

module.exports = {
  FAILURE,
  TRANSIENT_STATUS,
  FATAL_REQUEST_STATUS,
  MODEL_PATTERNS,
  classifyFailure,
  invalidResponse,
  retryAfterMs,
};
