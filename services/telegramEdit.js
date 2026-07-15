/**
 * Route Control — Telegram edit error model + bounded retry.
 *
 * ONE canonical classifier (`classifyTelegramError`) turns any Telegram edit
 * failure into a structured, allowlisted result, and ONE retry wrapper
 * (`runTelegramEditWithRetry`) retries the exact same in-place operation for
 * transient transport/5xx/429 failures only — never permanent rejections, and
 * never by sending a new or replacement message.
 *
 * The motivating production failure: a `socket hang up` (ECONNRESET) during the
 * multipart `editMessageMedia` upload for a text→photo conversion, with NO
 * Telegram HTTP response. That is AMBIGUOUS — Telegram may have applied the edit
 * before the response socket died — so we retry the same op; a follow-up
 * "message is not modified" is treated as confirmed success, and if every
 * attempt dies on the wire we report the outcome as UNCONFIRMED rather than a
 * proven rejection.
 *
 * SAFETY: nothing here ever returns or logs bot tokens, Authorization headers,
 * full request URLs, cookies, stack traces, DB URLs, screenshot bytes, or
 * personal data — only allowlisted codes and a sanitized short description.
 */

const CATEGORY = Object.freeze({
  TRANSPORT: 'transport',
  TELEGRAM_API: 'telegram_api',
  VALIDATION: 'validation',
  PERMISSION: 'permission',
  MESSAGE_STATE: 'message_state',
  RATE_LIMIT: 'rate_limit',
  UNKNOWN: 'unknown',
});

// Transport-level codes we recognize from err.code / err.errno / err.cause.*
const TRANSPORT_CODE_RE = /^(ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ECONNABORTED|EADDRNOTAVAIL|ENETDOWN)$/;

/** Collect candidate error codes from all the safe places Node/Telegraf hide them. */
function gatherCodes(err) {
  const out = [];
  const push = (v) => { if (v != null && v !== '') out.push(String(v).toUpperCase()); };
  push(err?.code);
  push(err?.errno);
  push(err?.type);
  push(err?.cause?.code);
  push(err?.cause?.errno);
  return out;
}

/** A short, token/URL-free description safe to show an admin. */
function sanitizeDescription(err) {
  let msg = String(err?.response?.description || err?.message || '');
  // Strip anything that could carry a bot token or credentials.
  msg = msg.replace(/https?:\/\/\S+/gi, '[url]');
  msg = msg.replace(/bot\d+:[A-Za-z0-9_-]+/gi, '[token]');
  msg = msg.replace(/\s+/g, ' ').trim();
  return msg.slice(0, 160);
}

/**
 * PURE. Classify a Telegram error into the structured model. Never throws.
 *
 * @param {any} err
 * @param {{ operation?: string, correlationId?: string }} [ctx]
 * @returns {{
 *   code:string, category:string, operation:string, retryable:boolean,
 *   ambiguousOutcome:boolean, telegramErrorCode:(number|null),
 *   transportCode:(string|null), description:string,
 *   retryAfterSeconds:(number|null), correlationId:(string|null)
 * }}
 */
function classifyTelegramError(err, { operation = 'edit', correlationId = null } = {}) {
  const telegramErrorCode = Number.isFinite(Number(err?.response?.error_code))
    ? Number(err.response.error_code) : null;
  const descRaw = String(err?.response?.description || err?.message || '');
  const desc = descRaw.toLowerCase();
  const codes = gatherCodes(err);
  const has = (c) => codes.includes(c);
  const transportCode = codes.find((c) => TRANSPORT_CODE_RE.test(c)) || null;

  const make = (fields) => ({
    operation,
    telegramErrorCode,
    transportCode: fields.transportCode ?? transportCode ?? null,
    retryAfterSeconds: null,
    correlationId,
    ...fields,
  });

  // ── Telegram RESPONDED (Bot API errors) — inspect these before transport ──
  if (desc.includes('message is not modified')) {
    return make({ code: 'NOT_MODIFIED', category: CATEGORY.MESSAGE_STATE, retryable: false, ambiguousOutcome: false, description: 'The message was already up to date.' });
  }
  if (desc.includes('message to edit not found') || desc.includes('message not found')) {
    return make({ code: 'MESSAGE_NOT_FOUND', category: CATEGORY.MESSAGE_STATE, retryable: false, ambiguousOutcome: false, description: 'The original Telegram message could not be found (it may have been deleted).' });
  }
  if (desc.includes("message can't be edited") || desc.includes('message can not be edited')) {
    return make({ code: 'MESSAGE_NOT_EDITABLE', category: CATEGORY.MESSAGE_STATE, retryable: false, ambiguousOutcome: false, description: 'Telegram will not allow this message to be edited.' });
  }
  if (telegramErrorCode === 403 || /forbidden|not enough rights|have no rights|bot was kicked|bot is not a member|not a member of the/i.test(descRaw)) {
    return make({ code: 'BOT_PERMISSION', category: CATEGORY.PERMISSION, retryable: false, ambiguousOutcome: false, description: 'The bot does not have permission to edit the message in that group.' });
  }
  if (desc.includes('there is no text in the message to edit')) {
    return make({ code: 'NO_TEXT_IN_MESSAGE', category: CATEGORY.MESSAGE_STATE, retryable: false, ambiguousOutcome: false, description: 'The message has no text to edit.' });
  }
  if (telegramErrorCode === 429) {
    const retryAfter = Number(err?.response?.parameters?.retry_after);
    return make({ code: 'TELEGRAM_RATE_LIMITED', category: CATEGORY.RATE_LIMIT, retryable: true, ambiguousOutcome: false, retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : null, description: 'Telegram temporarily rate-limited the update.' });
  }
  if (telegramErrorCode != null && telegramErrorCode >= 500 && telegramErrorCode <= 599) {
    return make({ code: 'TELEGRAM_SERVICE_ERROR', category: CATEGORY.TELEGRAM_API, retryable: true, ambiguousOutcome: false, description: `Telegram had a temporary server error (${telegramErrorCode}).` });
  }

  // ── Transport-level (no Bot API response) — inspect nested codes + message ──
  const isReset = has('ECONNRESET') || has('EPIPE') || /socket hang up|econnreset|epipe|connection reset/i.test(descRaw);
  const isTimeout = has('ETIMEDOUT') || has('ESOCKETTIMEDOUT') || has('ECONNABORTED')
    || /timed out|timeout|operation was aborted|aborted/i.test(descRaw);
  const isUnreachable = has('ENETUNREACH') || has('EHOSTUNREACH') || has('ECONNREFUSED') || has('ENETDOWN') || has('EADDRNOTAVAIL');
  const isDns = has('EAI_AGAIN') || has('ENOTFOUND') || /getaddrinfo|dns/i.test(descRaw);

  if (isReset) {
    // AMBIGUOUS: the request body may have reached Telegram before the socket died.
    return make({ code: 'TELEGRAM_CONNECTION_RESET', category: CATEGORY.TRANSPORT, retryable: true, ambiguousOutcome: true, transportCode: transportCode || 'ECONNRESET', description: 'The connection closed while Telegram was receiving the request.' });
  }
  if (isTimeout) {
    return make({ code: 'TELEGRAM_TIMEOUT', category: CATEGORY.TRANSPORT, retryable: true, ambiguousOutcome: true, transportCode: transportCode || 'ETIMEDOUT', description: 'The request to Telegram timed out before a response.' });
  }
  if (isUnreachable) {
    // The request almost certainly never reached Telegram → not ambiguous.
    return make({ code: 'TELEGRAM_NETWORK_UNREACHABLE', category: CATEGORY.TRANSPORT, retryable: true, ambiguousOutcome: false, transportCode: transportCode || 'ENETUNREACH', description: 'Telegram was unreachable from the server.' });
  }
  if (isDns) {
    return make({ code: 'TELEGRAM_DNS_FAILURE', category: CATEGORY.TRANSPORT, retryable: true, ambiguousOutcome: false, transportCode: transportCode || 'EAI_AGAIN', description: 'A temporary DNS failure prevented reaching Telegram.' });
  }

  if (telegramErrorCode === 400) {
    return make({ code: 'TELEGRAM_EDIT_REJECTED', category: CATEGORY.VALIDATION, retryable: false, ambiguousOutcome: false, description: `Telegram rejected the update (400)${descRaw ? `: ${sanitizeDescription(err)}` : ''}` });
  }
  return make({ code: 'TELEGRAM_EDIT_FAILED', category: CATEGORY.UNKNOWN, retryable: false, ambiguousOutcome: false, description: `Unexpected Telegram error${descRaw ? `: ${sanitizeDescription(err)}` : ''}` });
}

const defaultSleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); });

/**
 * Bound one edit attempt with a timeout so we never hang on the very long
 * Telegraf default. The underlying request may still finish in the background;
 * the caller uses a fresh (no-keepalive) socket for retries so a dead/abandoned
 * socket is never reused. A timeout is classified as an AMBIGUOUS transport
 * failure (Telegram may have applied the edit).
 */
function withTimeout(fn, ms, operation) {
  if (!ms || ms <= 0) return Promise.resolve().then(fn);
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const e = new Error(`Telegram ${operation} timed out after ${ms}ms`);
      e.code = 'ETIMEDOUT';
      reject(e);
    }, ms);
    if (timer.unref) timer.unref();
    Promise.resolve().then(fn).then(
      (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
      (err) => { if (done) return; done = true; clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Run one Telegram edit operation with bounded retries. Retries ONLY transient
 * failures (transport resets/timeouts/unreachable/DNS, Telegram 5xx, and 429 —
 * honouring retry_after with a cap). Permanent failures (400/403/message-state)
 * are returned immediately. A "message is not modified" at any point is SUCCESS
 * (the edit had already applied). Never sends a new/replacement message — it
 * only re-invokes the SAME idempotent `fn` (same chat + message id).
 *
 * @param {() => Promise<any>} fn  performs the single edit call
 * @param {object} [opts]
 * @returns {Promise<{ ok:boolean, notModified:boolean, attempts:number,
 *   classification:(object|null), result:any }>}
 */
async function runTelegramEditWithRetry(fn, {
  operation = 'edit',
  correlationId = null,
  maxAttempts = 3,
  baseDelayMs = 400,
  maxDelayMs = 8000,
  retryAfterCapSeconds = 30,
  perAttemptTimeoutMs = 30000,
  sleep = defaultSleep,
  random = Math.random,
  onAttempt = null,
} = {}) {
  let lastClass = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    try {
      const result = await withTimeout(fn, perAttemptTimeoutMs, operation);
      if (onAttempt) onAttempt({ attempt, ok: true, durationMs: Date.now() - startedAt, classification: null });
      return { ok: true, notModified: false, attempts: attempt, classification: null, result };
    } catch (err) {
      const classification = classifyTelegramError(err, { operation, correlationId });
      lastClass = classification;
      if (classification.code === 'NOT_MODIFIED') {
        // Already applied — possibly by a prior attempt whose response was lost.
        if (onAttempt) onAttempt({ attempt, ok: true, durationMs: Date.now() - startedAt, classification });
        return { ok: true, notModified: true, attempts: attempt, classification, result: null };
      }
      if (onAttempt) onAttempt({ attempt, ok: false, durationMs: Date.now() - startedAt, classification });
      const canRetry = classification.retryable && attempt < maxAttempts;
      if (!canRetry) {
        return { ok: false, notModified: false, attempts: attempt, classification, result: null };
      }
      let delayMs;
      if (classification.code === 'TELEGRAM_RATE_LIMITED' && classification.retryAfterSeconds != null) {
        delayMs = Math.min(classification.retryAfterSeconds, retryAfterCapSeconds) * 1000 + 250;
      } else {
        const exp = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
        // Half fixed + half jitter so retries de-synchronize without long waits.
        delayMs = Math.round(exp / 2 + random() * (exp / 2));
      }
      await sleep(delayMs);
    }
  }
  return { ok: false, notModified: false, attempts: maxAttempts, classification: lastClass, result: null };
}

module.exports = {
  CATEGORY,
  classifyTelegramError,
  runTelegramEditWithRetry,
  sanitizeDescription,
  withTimeout,
};
