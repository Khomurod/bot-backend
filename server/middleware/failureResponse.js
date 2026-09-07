'use strict';

/**
 * Turning a thrown error into an HTTP response that says WHAT went wrong.
 *
 * WHY IT EXISTS. Route handlers reported failures in two ways, and both hid the
 * cause. Most sent `500 { error: 'Server error' }`, which tells an admin
 * nothing. Several were worse: they caught the error and answered `200
 * { states: [] }`, so a database that was unreachable, out of monthly transfer
 * allowance, or refusing credentials looked exactly like a company that owns no
 * trailers. Empty data presented as normal is the failure mode this module
 * exists to remove.
 *
 * `sendFailure` classifies (via the `dbFailure` tag database/pool.js attaches,
 * or by re-classifying) and answers with the machine-readable `code` that
 * admin/src/utils/pageFailure.js maps to real wording — "the database could not
 * be reached", "a usage limit was reached" — plus the underlying detail, which
 * is never swallowed.
 *
 * `createErrorHandler` is the terminal Express handler. Without one, an error
 * escaping a handler produced Express's default HTML stack page; the admin's
 * fetch layer saw HTML where JSON belonged and reported "this tab is running an
 * outdated version" — a wrong diagnosis for what was actually a server fault.
 */

const { classifyDatabaseError } = require('../../lib/database/failureClassification');

/**
 * What Express's body parser rejects, in words an operator can act on. The
 * parser runs BEFORE every route — ahead of the auth middleware — so these are
 * the failures most likely to reach the terminal handler.
 */
const BODY_PARSER_MESSAGES = {
  'entity.parse.failed': 'Request body is not valid JSON',
  'entity.too.large': 'Request body is too large',
  'encoding.unsupported': 'Request body encoding is not supported',
  'charset.unsupported': 'Request body charset is not supported',
  'request.aborted': 'Request was aborted before it finished',
};

/**
 * A status the ERROR ITSELF carries, when the request is at fault.
 *
 * Two sources put one there: Express's body parser (a malformed JSON body is
 * `entity.parse.failed`, status 400) and this repo's own services, several of
 * which throw with an explicit `statusCode` — 400 for a missing field, 404 for
 * a record, 502 for a rejected send.
 *
 * Only 4xx is adopted. A 5xx on the error is already what the default says, and
 * "the server broke" is the safer reading of an unexpected one; but answering
 * 500 to a malformed body tells an operator the SERVER failed when the REQUEST
 * did, which is the wrong place to go looking. Deliberately 4xx-only, so an
 * error cannot talk its way into a 2xx or 3xx.
 *
 * @returns {{status: number, message: string}|{}} empty when it is not a client
 *   error, so `sendFailure`'s 500 / 'Server error' defaults still apply.
 */
function clientErrorResponse(error) {
  const raw = Number(error?.status ?? error?.statusCode);
  if (!Number.isInteger(raw) || raw < 400 || raw > 499) return {};
  const message = BODY_PARSER_MESSAGES[error?.type]
    || String(error?.message || '').slice(0, 200)
    || 'Request could not be processed';
  return { status: raw, message };
}

/**
 * Answer a failed request.
 *
 * @param {import('express').Response} res
 * @param {Error} error the thrown error
 * @param {object} [options]
 * @param {string} [options.message] what the caller was trying to do, e.g.
 *   'Failed to load trailer states'. Used when the failure is not a database
 *   infrastructure problem.
 * @param {number} [options.status=500] status for a non-database failure.
 * @param {string} [options.logPrefix] log tag, e.g. '[TRAILER-API]'.
 */
function sendFailure(res, error, options = {}) {
  const { message = 'Server error', status = 500, logPrefix = '[API]' } = options;
  const failure = error?.dbFailure || classifyDatabaseError(error);
  const detail = String(error?.message || '').slice(0, 500);

  if (failure) {
    console.error(`${logPrefix} ${failure.code}: ${detail}`);
    return res.status(failure.status).json({
      error: failure.message,
      code: failure.code,
      detail,
      retryable: failure.retryable,
    });
  }

  console.error(`${logPrefix} ${message}: ${detail}`);
  return res.status(status).json({ error: message, detail });
}

/**
 * The terminal error handler. Mount LAST, after every route.
 *
 * Four arguments is not optional here — Express identifies an error handler by
 * its arity, and a three-argument function is silently treated as ordinary
 * middleware that never runs on an error.
 *
 * This is the ONE place a status is inferred from the error, because it is the
 * one place with no caller intent to respect: `sendFailure`'s other callers
 * pass a status deliberately and keep it. A database failure still outranks
 * everything (an unreachable database is not the request's fault, whatever
 * status happens to be attached).
 */
function createErrorHandler() {
  return function handleRouteError(error, req, res, next) {
    if (res.headersSent) {
      // Something already answered; let Express close the connection rather
      // than trying to write a second set of headers.
      return next(error);
    }
    return sendFailure(res, error, {
      ...clientErrorResponse(error),
      logPrefix: `[API] Unhandled error on ${req.method} ${req.originalUrl}`,
    });
  };
}

module.exports = { sendFailure, createErrorHandler, clientErrorResponse };
