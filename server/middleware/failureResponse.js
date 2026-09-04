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
 */
function createErrorHandler() {
  return function handleRouteError(error, req, res, next) {
    if (res.headersSent) {
      // Something already answered; let Express close the connection rather
      // than trying to write a second set of headers.
      return next(error);
    }
    return sendFailure(res, error, {
      message: 'Server error',
      logPrefix: `[API] Unhandled error on ${req.method} ${req.originalUrl}`,
    });
  };
}

module.exports = { sendFailure, createErrorHandler };
