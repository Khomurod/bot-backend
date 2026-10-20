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

/**
 * "This request is too big FOR THIS MODEL" — not a spent allowance, not an
 * unwell provider. Groq answers a request whose max_tokens exceeds one model's
 * per-minute OUTPUT cap with `429 Request too large for model … reduce
 * max_tokens`, and ends the message with a link to its billing page.
 *
 * Read as QUOTA (the billing link matched), that one oversized request cooled
 * ALL of Groq until the next UTC midnight. In production it happened at 00:04
 * on 19 October and 00:25 on 20 October, and for the rest of each day every
 * AI feature had no provider — Safety Approvals gave up on twenty replies.
 * The next model, which may well take the request, is the right move.
 */
const REQUEST_TOO_LARGE_PATTERNS = [
  /request too large/i, /reduce max_tokens/i, /context[_\s-]?length[_\s-]?exceeded/i,
  /maximum context length/i,
];

/**
 * A limit counted per MINUTE (Groq's TPM / RPM / OTPM). It resets in seconds,
 * so it is busy, not spent — whatever link the message ends with. A per-DAY
 * limit (TPD / RPD, OpenRouter's `free-models-per-day`) stays QUOTA.
 */
const PER_MINUTE_PATTERNS = [/per minute/i, /\((?:TPM|RPM|OTPM|ITPM)\)/];
const PER_DAY_PATTERNS = [/per day/i, /\((?:TPD|RPD)\)/, /-per-day/i];

/**
 * A spent allowance that names ONE model: Groq's "Rate limit reached for model
 * `openai/gpt-oss-20b` … tokens per day", Gemini's "… limit: 20, model:
 * gemini-2.5-flash". Both count free allowances per model, so the rest of the
 * provider's chain is still good — only this model waits for its reset.
 * Spent credits, an account-wide daily allowance and anything that names no
 * model stay provider-wide.
 */
const MODEL_SCOPED_QUOTA = [/\bfor model\s+[`'"]?[\w.:/-]+/i, /\bmodel:\s*[\w.:/-]+/i];
const PROVIDER_WIDE_QUOTA = [/credits?\b/i, /prepayment/i, /free-models-per-day/i, /balance/i];

/** 'model' when the spent allowance is that one model's own; else 'provider'. */
function quotaScope(text) {
  if (anyMatch(PROVIDER_WIDE_QUOTA, text)) return 'provider';
  return anyMatch(MODEL_SCOPED_QUOTA, text) ? 'model' : 'provider';
}

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

  // Before QUOTA, because both can carry a billing link: an oversized request
  // is this model's limit, and a per-minute limit is seconds away from reset.
  if (anyMatch(REQUEST_TOO_LARGE_PATTERNS, text)) {
    return {
      kind: FAILURE.FATAL_REQUEST,
      retryable: false,
      nextProvider: true,
      // The provider is fine; this model cannot take this request.
      coolProvider: false,
      skipModel: true,
    };
  }
  if (anyMatch(PER_MINUTE_PATTERNS, text) && !anyMatch(PER_DAY_PATTERNS, text)) {
    return {
      kind: FAILURE.TRANSIENT, retryable: true, nextProvider: true, coolProvider: true,
    };
  }

  if (anyMatch(QUOTA_PATTERNS, text) || (numericStatus === 429 && anyMatch(PER_DAY_PATTERNS, text))) {
    const scope = quotaScope(text);
    return {
      kind: FAILURE.QUOTA,
      retryable: false,
      // A model's own allowance: pause the model and ask the next one of the
      // same provider. Anything wider: the provider waits.
      nextProvider: scope === 'provider',
      coolProvider: scope === 'provider',
      scope,
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
  // Groq writes long waits as "12m35.136s".
  const minutes = String(message || '').match(/(?:try again|retry)\s+in\s+(\d+)m([\d.]+)s/i);
  if (minutes) {
    const ms = (Number(minutes[1]) * 60 + Number(minutes[2])) * 1000;
    if (Number.isFinite(ms) && ms > 0) return Math.min(Math.ceil(ms), maxMs);
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
  REQUEST_TOO_LARGE_PATTERNS,
  PER_MINUTE_PATTERNS,
  classifyFailure,
  quotaScope,
  invalidResponse,
  retryAfterMs,
};
