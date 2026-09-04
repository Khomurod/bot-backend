'use strict';

/**
 * WHICH kind of database failure is this?
 *
 * Pure: no I/O, no state. Used by the database boundary (database/pool.js),
 * by the route helpers that turn a failure into a response, and by the tests.
 *
 * WHY IT EXISTS. Every database failure used to reach the admin panel as an
 * opaque 500 with whatever `err.message` happened to say — or, worse, as an
 * empty list that looked exactly like "there is no data". An administrator
 * could not tell an outage from an empty table, a quota refusal from a bug, or
 * a permission problem from either. These codes are the vocabulary that lets
 * the UI say the true thing; the browser half of the mapping lives in
 * admin/src/utils/pageFailure.js.
 *
 * The DEFAULT IS "not an infrastructure failure". A unique-violation or a
 * syntax error is a bug in the application, not a sick database, and calling it
 * an outage would send someone to check Supabase's status page over a typo.
 */

/** The machine-readable codes the API sends, and the browser understands. */
const FAILURE_CODES = {
  /** The database could not be reached at all. */
  DB_UNAVAILABLE: 'DB_UNAVAILABLE',
  /** Reachable, but the work did not finish in time or had no free connection. */
  DB_TIMEOUT: 'DB_TIMEOUT',
  /** The database refused the credentials or the object permissions. */
  DB_PERMISSION: 'DB_PERMISSION',
  /** A plan or usage limit was hit — not a fault, a ceiling. */
  DB_QUOTA: 'DB_QUOTA',
  /** A query failed for a reason that is the application's own. */
  DB_ERROR: 'DB_ERROR',
};

/**
 * PostgreSQL SQLSTATE classes that mean the SERVER or the CONNECTION is the
 * problem — never the query. Source: PostgreSQL "Appendix A. Error Codes".
 */
const SQLSTATE_UNAVAILABLE = new Set([
  '08000', '08003', '08006', '08001', '08004', '08007', '08P01', // connection exception
  '57P01', '57P02', '57P03', // admin shutdown, crash shutdown, cannot connect now
  '58000', '58030', // system error, io error
  '3D000', // database does not exist
  'XX000', // internal error
]);

const SQLSTATE_TIMEOUT = new Set([
  '53300', // too_many_connections
  '53400', // configuration_limit_exceeded
  '55P03', // lock_not_available
  '57014', // query_canceled (statement timeout)
  '40001', // serialization_failure — retryable
  '40P01', // deadlock_detected — retryable
]);

const SQLSTATE_PERMISSION = new Set([
  '28000', '28P01', // invalid_authorization_specification, invalid_password
  '42501', // insufficient_privilege
]);

const SQLSTATE_RESOURCE = new Set([
  '53100', // disk_full
  '53200', // out_of_memory
]);

/** Node/OS-level errors from the socket layer, before any SQLSTATE exists. */
const SYSTEM_UNAVAILABLE = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPROTO', 'CERT_HAS_EXPIRED',
]);

const SYSTEM_TIMEOUT = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT']);

/**
 * Messages the pg driver and the hosted providers produce that carry no usable
 * code. Each has been seen in practice; the quota ones are how a Supabase
 * project that has exhausted its plan or been paused presents itself.
 */
const MESSAGE_UNAVAILABLE = [
  /connection terminated/i,
  /connection ended unexpectedly/i,
  /client has encountered a connection error/i,
  /server closed the connection unexpectedly/i,
  /terminating connection/i,
  /ssl connection has been closed/i,
  /could not connect/i,
  /getaddrinfo/i,
  /connect econnrefused/i,
  /the database is not available/i,
];

const MESSAGE_TIMEOUT = [
  /timeout exceeded when trying to connect/i,
  /connection timeout/i,
  /query read timeout/i,
  /statement timeout/i,
  /sorry, too many clients already/i,
  /remaining connection slots are reserved/i,
];

const MESSAGE_QUOTA = [
  /quota/i,
  /egress/i,
  /data transfer/i,
  /exceeded .*(limit|allowance|plan)/i,
  /project is paused/i,
  /project has been paused/i,
  /disk (is )?full/i,
  /over.?(usage|limit)/i,
];

const matches = (patterns, text) => Boolean(text) && patterns.some((re) => re.test(text));

/**
 * Classify an error thrown by the database layer.
 *
 * @param {Error} error
 * @returns {{code: string, status: number, message: string, retryable: boolean}|null}
 *   null when the error is NOT an infrastructure failure — a constraint
 *   violation, a syntax error, anything the application itself got wrong.
 */
function classifyDatabaseError(error) {
  if (!error) return null;
  const sqlstate = typeof error.code === 'string' ? error.code.toUpperCase() : '';
  const message = String(error.message || '');

  // A ceiling, not a fault: checked first so "disk full" is reported as a limit
  // rather than as an outage an admin would try to restart their way out of.
  if (SQLSTATE_RESOURCE.has(sqlstate) || matches(MESSAGE_QUOTA, message)) {
    return {
      code: FAILURE_CODES.DB_QUOTA,
      status: 503,
      message: 'The database refused the request because a usage limit was reached.',
      retryable: false,
    };
  }
  if (SQLSTATE_PERMISSION.has(sqlstate)) {
    return {
      code: FAILURE_CODES.DB_PERMISSION,
      status: 503,
      message: 'The database rejected this application\'s credentials or permissions.',
      retryable: false,
    };
  }
  if (SQLSTATE_UNAVAILABLE.has(sqlstate)
      || SYSTEM_UNAVAILABLE.has(sqlstate)
      || matches(MESSAGE_UNAVAILABLE, message)) {
    return {
      code: FAILURE_CODES.DB_UNAVAILABLE,
      status: 503,
      message: 'The database could not be reached.',
      retryable: true,
    };
  }
  if (SQLSTATE_TIMEOUT.has(sqlstate)
      || SYSTEM_TIMEOUT.has(sqlstate)
      || matches(MESSAGE_TIMEOUT, message)) {
    return {
      code: FAILURE_CODES.DB_TIMEOUT,
      status: 503,
      message: 'The database did not answer in time or had no free connection.',
      retryable: true,
    };
  }
  return null;
}

/** True when this error means the database, not the query, is the problem. */
function isDatabaseFailure(error) {
  return classifyDatabaseError(error) !== null;
}

module.exports = { FAILURE_CODES, classifyDatabaseError, isDatabaseFailure };
